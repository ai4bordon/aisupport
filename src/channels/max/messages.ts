/**
 * Запись сообщений канала MAX в таблицу `messages` (R16, B18).
 *
 * Канал MAX писал только трассу (`agent_steps`), но не переписку: лента
 * канала на экране демо, история диалога в кабинете менеджера и
 * идемпотентная ветка веб-чата смотрят именно в `messages`. Без записи
 * сообщений эти три места показывают пустоту при живом общении.
 *
 * Идентификатор сообщения MAX — строка вида `mid.…`, а `client_message_id`
 * в таблице объявлен uuid. Идентификатор детерминированно выводится из
 * `mid`: тот же `mid` всегда даёт тот же uuid, поэтому повтор события не
 * создаёт вторую строку, а уникальный индекс
 * `messages_tenant_client_message_id_idx` работает как идемпотентность.
 */

import { createHash } from "node:crypto";

/** Минимальный контракт пула: запись сообщений работает и с тестовым пулом. */
export type MessagePoolLike = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Детерминированный uuid из строки.
 *
 * Байты берутся из хеша SHA-256: одинаковая строка всегда даёт одинаковый
 * uuid, разные строки — разные с вероятностью, неотличимой от случайной.
 * Версия и вариант выставляются как у uuid четвёртой версии, чтобы значение
 * проходило проверку формата.
 */
export function deterministicUuid(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] ?? 0) & 0x0f;
  bytes[6] = (bytes[6] ?? 0) | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f;
  bytes[8] = (bytes[8] ?? 0) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Сообщение, которое пишется в переписку. */
export type RecordedMessage = {
  /** Арендатор. */
  tenantId: string;
  /** Диалог. */
  conversationId: string;
  /**
   * Идентификатор сообщения канала (`mid` в MAX).
   *
   * Для реплики клиента — исходный `mid`; для ответа агента — `mid` с
   * префиксом ответа, чтобы идентификаторы не совпали.
   */
  messageId: string;
  /** Роль: `client` или `agent`. */
  role: "client" | "agent";
  /** Текст сообщения: маскированный для клиента, восстановленный для агента. */
  text: string;
  /** Источники ответа агента. */
  sources?: unknown[];
};

/**
 * Порт записи сообщения в переписку.
 *
 * Канал не знает базы: запись делает сервис, подключённый воркером.
 */
export type MessageRecordPort = (message: RecordedMessage) => Promise<void>;

/**
 * Создаёт порт записи сообщений.
 *
 * Повторная запись того же сообщения не создаёт вторую строку: уникальный
 * индекс по `(tenant_id, client_message_id)` отбрасывает дубль.
 */
export function createMessageRecorder(
  pool: MessagePoolLike,
): MessageRecordPort {
  return async (message: RecordedMessage): Promise<void> => {
    await pool.query(
      `INSERT INTO messages (
         tenant_id, conversation_id, client_message_id, role,
         text_masked, text_original, sources
       ) VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb)
       ON CONFLICT (tenant_id, client_message_id) DO NOTHING`,
      [
        message.tenantId,
        message.conversationId,
        deterministicUuid(message.messageId),
        message.role,
        message.text,
        JSON.stringify(message.sources ?? []),
      ],
    );
  };
}
