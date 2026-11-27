/**
 * Состояние подбора в диалоге (ADR-0015, R1a/R1b).
 *
 * Слоты накапливаются по диалогу: клиент отвечает на уточняющий вопрос, и
 * ответ дополняет уже собранное состояние. Значения лежат в базе, а не в
 * памяти процесса: диалог может продолжиться после перезапуска.
 */

import { getPool } from "@/db/pool";
import { withDialogLock } from "@/core/dialog-lock";
import { parseCatalogDomain } from "@/core/catalog-domain";
import type { RequirementSlots } from "@/core/catalog-lookup";

/** Имена слотов — как в таблице `conversation_slots`. */
const SLOT_NAMES = [
  "quantity",
  "termMonths",
  "deployment",
  "vendor",
  "budget",
  "productQuery",
  "discovery",
  "domain",
] as const;

/** Имя слота. */
type SlotName = (typeof SLOT_NAMES)[number];

/**
 * Разбирает значение слота из базы.
 *
 * Значения слотов приходят из базы, а база — недоверенный источник: слот
 * мог быть заполнен чем угодно (правка вручную, импорт, ошибка в коде).
 * Поэтому значение проверяется по своему типу, а не приводится к нему
 * приведением: иначе «много» становилось числом, а неизвестный домен
 * ронял подбор молча.
 *
 * Некорректное значение игнорируется: слот считается незаполненным.
 */
function parseSlotValue(name: SlotName, value: string): string | number | null {
  switch (name) {
    case "quantity":
    case "termMonths": {
      // Только целое число: срок в месяцах и количество лицензий не бывают
      // дробными.
      if (!/^\d+$/u.test(value)) return null;
      const number = Number.parseInt(value, 10);
      return Number.isFinite(number) ? number : null;
    }
    case "domain": {
      return parseCatalogDomain(value);
    }
    case "deployment": {
      // Развёртывание — одно из двух слов: «сервер» или «облако».
      const lower = value.toLowerCase();
      return lower === "сервер" || lower === "облако" ? lower : null;
    }
    case "budget": {
      // Бюджет — сумма в рублях строкой или ответ «нет».
      if (value === "нет") return "нет";
      const digits = value.replace(/[^\d]/gu, "");
      if (digits.length === 0) return null;
      const number = Number.parseInt(digits, 10);
      return Number.isFinite(number) ? String(number) : null;
    }
    default:
      return value;
  }
}

/**
 * Читает собранные слоты диалога.
 *
 * Незакрытым считается слот, которого нет в таблице или значение которого
 * пустое либо некорректное.
 */
export async function loadSlots(
  conversationId: string,
): Promise<RequirementSlots> {
  const slots: RequirementSlots = {
    quantity: null,
    termMonths: null,
    deployment: null,
    vendor: null,
    budget: null,
    productQuery: null,
    discovery: null,
    domain: null,
  };

  const result = await getPool().query<{ slot: string; value: string }>(
    "SELECT slot, value FROM conversation_slots WHERE conversation_id = $1",
    [conversationId],
  );

  for (const row of result.rows) {
    const name = row.slot as SlotName;
    if (!SLOT_NAMES.includes(name)) continue;
    const value = row.value.trim();
    if (value.length === 0) continue;
    const parsed = parseSlotValue(name, value);
    if (parsed === null) continue;
    if (name === "quantity" || name === "termMonths") {
      slots[name] = parsed as number;
    } else {
      slots[name] = parsed as string;
    }
  }

  return slots;
}

/**
 * Сохраняет слоты диалога.
 *
 * Записываются только непустые значения: пустой слот означает, что данные не
 * собраны, и хранить его нечего.
 *
 * Запись идёт под блокировкой диалога (`src/core/dialog-lock.ts`): два
 * параллельных хода одного диалога читают слоты до записи, и без
 * сериализации второй ход затирал бы первый. Перезапись непустого значения
 * пустым невозможна: пустые слоты не пишутся вовсе.
 */
export async function saveSlots(
  conversationId: string,
  slots: RequirementSlots,
): Promise<void> {
  await withDialogLock(conversationId, async (client) => {
    for (const name of SLOT_NAMES) {
      const value = slots[name];
      if (value === null) continue;
      await client.query(
        `INSERT INTO conversation_slots (conversation_id, slot, value, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (conversation_id, slot)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [conversationId, name, String(value)],
      );
    }
  });
}
