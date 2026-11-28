import { getPool } from "@/db/pool";
import { maskPersonalData, type MaskMapping } from "@/core/mask";
import { createMaskMappingStore } from "@/core/mask-store";

/**
 * История диалога для промпта ответа.
 *
 * Ответ агента должен опираться на то, что клиент уже сказал. Название
 * продукта и количество названы в первом ходе, во втором клиент задаёт
 * уточняющий вопрос, и без переписки модель видит только текущую реплику:
 * контекст теряется, и ответ не опирается на данные клиента.
 *
 * Инварианты:
 * - в промпт уходит только замаскированный текст: сырых персональных
 *   данных в истории нет;
 * - объём ограничен: последние сообщения диалога, предел на одно сообщение
 *   и предел на весь блок, иначе история съедает бюджет входных токенов;
 * - читается только переписка своего арендатора и своего диалога.
 */

/**
 * Сколько последних сообщений диалога попадает в блок истории.
 *
 * Восьми хватает, чтобы увидеть начало подбора и уточняющие вопросы, и
 * мало, чтобы промпт не разрастался: полная переписка длинного диалога
 * стоила бы дороже, чем весь ответ.
 */
export const MAX_HISTORY_MESSAGES = 8;

/**
 * Сколько символов максимум занимает одно сообщение в блоке истории.
 *
 * Предел на сообщение нужен отдельно от предела на блок: одна длинная
 * реплика клиента иначе вытеснила бы из истории весь предыдущий разговор.
 */
export const MAX_HISTORY_MESSAGE_CHARS = 300;

/**
 * Сколько символов максимум занимает весь блок истории.
 *
 * Ограничение суммарное, а не на сообщение: переписка не должна раздувать
 * промпт тем же объёмом, что и подтверждённые источники.
 */
export const MAX_HISTORY_CHARS = 1200;

/** Сообщение переписки в том виде, в каком оно уходит в промпт. */
export type DialogHistoryMessage = {
  role: "client" | "agent" | "manager" | "system";
  /** Замаскированный текст сообщения: без исходных персональных данных. */
  text: string;
};

/** Строка переписки из базы. */
type HistoryRow = {
  id: string;
  role: string;
  text_masked: string;
  created_at: Date;
  reply_to_client_message_id: string | null;
};

/** Известные роли переписки. */
const ROLE_BY_NAME: Record<string, DialogHistoryMessage["role"]> = {
  client: "client",
  agent: "agent",
  manager: "manager",
  system: "system",
};

/** Подпись роли в блоке истории. */
const ROLE_LABEL: Record<DialogHistoryMessage["role"], string> = {
  client: "Клиент",
  agent: "Агент",
  manager: "Менеджер",
  system: "Система",
};

/**
 * Порядок сообщений внутри диалога.
 *
 * Реплика клиента и ответ агента одного хода пишутся одной транзакцией и
 * получают одинаковое время создания: без второго правила порядок внутри
 * хода был бы произвольным, и модель читала бы ответ раньше вопроса.
 */
function compareHistoryRows(left: HistoryRow, right: HistoryRow): number {
  const time = left.created_at.getTime() - right.created_at.getTime();
  if (time !== 0) return time;
  const leftIsReply = left.reply_to_client_message_id !== null;
  const rightIsReply = right.reply_to_client_message_id !== null;
  if (leftIsReply !== rightIsReply) return leftIsReply ? 1 : -1;
  return left.id.localeCompare(right.id);
}

/**
 * Читает последние сообщения переписки диалога.
 *
 * Текст берётся из `text_masked` и дополнительно прогоняется через
 * маскировщик: канал MAX пишет в переписку восстановленный ответ агента, и
 * без повторного маскирования сырые персональные данные попали бы в промпт.
 * Метки берутся из таблицы соответствий диалога, поэтому одна и та же
 * метка в истории и в текущем вопросе означает одно и то же значение.
 *
 * `currentText` — текст текущей реплики клиента. Канал MAX пишет реплику
 * клиента в переписку до вызова ядра, и без исключения текущая реплика
 * попала бы в историю второй раз.
 */
export async function loadDialogHistory(
  tenantId: string,
  conversationId: string,
  currentText: string = "",
): Promise<DialogHistoryMessage[]> {
  const pool = getPool();
  const result = await pool.query<HistoryRow>(
    `SELECT id, role, text_masked, created_at, reply_to_client_message_id
       FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    // С запасом: служебные записи хода (отказ с пустым текстом) в историю
    // не попадают, и обрезка по пределу сообщений не должна съедать место
    // на пустых строках.
    [tenantId, conversationId, MAX_HISTORY_MESSAGES * 2],
  );

  const rows = [...result.rows].sort(compareHistoryRows);
  const store = createMaskMappingStore(pool);
  const stored = await store.load(conversationId);

  // Накопленная таблица соответствий: одна и та же метка на все сообщения
  // истории, иначе одно и то же значение получило бы разные метки.
  let mapping: MaskMapping = { ...stored };
  const messages: DialogHistoryMessage[] = [];

  for (const row of rows) {
    const text = row.text_masked.trim();
    // Служебные записи хода (например, отказ с пустым текстом) контекста не
    // несут: в промпт они не попадают.
    if (text.length === 0) continue;

    const masked = maskPersonalData(text, { mapping });
    mapping = masked.mapping;
    messages.push({
      role: ROLE_BY_NAME[row.role] ?? "client",
      text: masked.maskedText,
    });
  }

  // Текущая реплика клиента в историю не входит: она уже есть в промпте
  // отдельным сообщением. Исключается только самая свежая реплика с таким
  // же текстом — та, что канал записал перед вызовом ядра.
  const last = messages.at(-1);
  if (
    last !== undefined &&
    last.role === "client" &&
    currentText.trim().length > 0 &&
    last.text.trim() === currentText.trim()
  ) {
    messages.pop();
  }

  // Новые метки сохраняются: иначе восстановленный ответ агента получил бы
  // метку, которой нет в таблице соответствий, и клиент увидел бы её
  // текстом вместо своих данных. Сбой записи историю не отменяет.
  const discovered: MaskMapping = {};
  for (const [label, value] of Object.entries(mapping)) {
    if (stored[label] === undefined) discovered[label] = value;
  }
  if (Object.keys(discovered).length > 0) {
    try {
      await store.save(conversationId, discovered);
    } catch {
      // Метки останутся несохранёнными: это влияет только на восстановление
      // имён в ответе, но не на содержимое промпта.
    }
  }

  return messages.slice(-MAX_HISTORY_MESSAGES);
}

/**
 * Текст блока истории для промпта.
 *
 * Свежие реплики важнее старых: при нехватке места отпадают самые ранние
 * сообщения, а не новые.
 */
export function buildHistoryContext(
  messages: readonly DialogHistoryMessage[],
): string {
  const lines: string[] = [];
  let total = 0;
  for (const message of [...messages].reverse()) {
    const text = message.text.slice(0, MAX_HISTORY_MESSAGE_CHARS);
    if (text.trim().length === 0) continue;
    const line = `${ROLE_LABEL[message.role]}: ${text}`;
    // Первое сообщение помещается всегда: иначе блок истории оказался бы
    // пустым, и модель потеряла бы контекст целиком.
    if (lines.length > 0 && total + line.length > MAX_HISTORY_CHARS) break;
    lines.unshift(line);
    total += line.length;
  }
  return lines.join("\n");
}
