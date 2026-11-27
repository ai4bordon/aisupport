/**
 * Состояние подбора в диалоге (ADR-0015, R1a/R1b).
 *
 * Слоты накапливаются по диалогу: клиент отвечает на уточняющий вопрос, и
 * ответ дополняет уже собранное состояние. Значения лежат в базе, а не в
 * памяти процесса: диалог может продолжиться после перезапуска.
 */

import { getPool } from "@/db/pool";
import type { RequirementSlots } from "@/core/catalog-lookup";

/** Имена слотов — как в таблице `conversation_slots`. */
const SLOT_NAMES = ["quantity", "termMonths", "deployment", "vendor", "productQuery"] as const;

/**
 * Читает собранные слоты диалога.
 *
 * Незакрытым считается слот, которого нет в таблице или значение которого
 * пустое.
 */
export async function loadSlots(
  conversationId: string,
): Promise<RequirementSlots> {
  const slots: RequirementSlots = {
    quantity: null,
    termMonths: null,
    deployment: null,
    vendor: null,
    productQuery: null,
  };

  const result = await getPool().query<{ slot: string; value: string }>(
    "SELECT slot, value FROM conversation_slots WHERE conversation_id = $1",
    [conversationId],
  );

  for (const row of result.rows) {
    const name = row.slot as keyof RequirementSlots;
    if (!SLOT_NAMES.includes(name)) continue;
    const value = row.value.trim();
    if (value.length === 0) continue;
    if (name === "quantity" || name === "termMonths") {
      const number = Number.parseInt(value, 10);
      slots[name] = Number.isFinite(number) ? number : null;
    } else {
      slots[name] = value;
    }
  }

  return slots;
}

/**
 * Сохраняет слоты диалога.
 *
 * Записываются только непустые значения: пустой слот означает, что данные не
 * собраны, и хранить его нечего.
 */
export async function saveSlots(
  conversationId: string,
  slots: RequirementSlots,
): Promise<void> {
  const pool = getPool();
  for (const name of SLOT_NAMES) {
    const value = slots[name];
    if (value === null) continue;
    await pool.query(
      `INSERT INTO conversation_slots (conversation_id, slot, value, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (conversation_id, slot)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [conversationId, name, String(value)],
    );
  }
}
