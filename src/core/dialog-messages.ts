import { randomUUID } from "node:crypto";
import { withDialogLock } from "@/core/dialog-lock";
import type { PoolClient } from "pg";

/**
 * Запись сообщений диалога под блокировкой диалога (R16, AC 4).
 *
 * Сообщения одного диалога пишутся в одной очереди: два параллельных
 * хода не должны повредить переписку друг друга. Запись сохраняет
 * идемпотентность `messages`: повтор того же `client_message_id` не
 * создаёт второе сообщение.
 */

export type DialogMessage = {
  tenantId: string;
  conversationId: string;
  /** Идентификатор сообщения клиента: ключ идемпотентности. */
  clientMessageId: string;
  role: "client" | "agent" | "manager" | "system";
  /** Текст сообщения в замаскированном виде: без исходных персональных данных. */
  maskedText: string;
  /** Исходный текст: хранится в базе, наружу не отдаётся. */
  originalText: string | null;
  sources: unknown[];
};

/**
 * Записывает сообщение в переписку диалога.
 *
 * Возвращает идентификатор записанного сообщения: при повторе того же
 * `client_message_id` возвращается идентификатор уже записанного
 * сообщения, а не создаётся дубль.
 */
export async function appendDialogMessage(
  message: DialogMessage,
): Promise<string> {
  const result = await withDialogLock(message.conversationId, async (client) =>
    insertMessage(client, message),
  );
  return result;
}

/**
 * Запись сообщения в указанное соединение.
 *
 * Отдельная функция, чтобы вызывающий код мог записать сообщение в
 * транзакции, которая уже открыта: так клиентское сообщение и ответ
 * агента попадают в переписку вместе.
 */
export async function insertMessage(
  client: PoolClient,
  message: DialogMessage,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (tenant_id, client_message_id) DO NOTHING
     RETURNING id`,
    [
      message.tenantId,
      message.conversationId,
      message.clientMessageId,
      message.role,
      message.maskedText,
      message.originalText,
      JSON.stringify(message.sources),
    ],
  );
  const row = result.rows[0];
  if (row) return row.id;

  // Конфликт: сообщение с таким `client_message_id` уже записано.
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM messages WHERE tenant_id = $1 AND client_message_id = $2",
    [message.tenantId, message.clientMessageId],
  );
  return existing.rows[0]?.id ?? randomUUID();
}
