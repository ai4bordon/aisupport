import { createHash } from "node:crypto";

import type { MaskPort, MaxUpdate, NormalizedMessage } from "./types";

/**
 * Нормализация входящего события Bot API MAX в нейтральный вход ядра.
 *
 * Событие приходит из `GET /updates` (`update_type: "message_created"`).
 * Всё, что не является текстовым сообщением в известном чате, отбрасывается:
 * пустое событие не должно ронять опрос.
 */

/**
 * Идентификатор диалога для канала MAX.
 *
 * Ядро (срез 01) хранит диалоги MAX по паре `(tenant_id, channel, external_chat_id)`,
 * поэтому канал не может знать uuid диалога заранее. Канал выводит
 * детерминированный uuid из `chat_id`: повторные события того же чата дают
 * один и тот же `conversationId`, разные чаты — разные.
 */
const MAX_NAMESPACE = "6f2a4d1e-3c5b-4a7d-9e11-0b7c5d2f8a30";

function conversationIdFor(chatId: string): string {
  const hash = createHash("sha1")
    .update(`${MAX_NAMESPACE}:${chatId}`)
    .digest("hex");
  // Разборка digest в форму RFC 4122 версии 5: 8-4-4-4-12.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export type NormalizeOptions = {
  /** Порт маскирования ПД ядра. Без порта текст идёт в ядро как есть. */
  mask?: MaskPort;
};

function isMessageCreated(update: MaxUpdate): update is Extract<MaxUpdate, { update_type: "message_created" }> {
  return update.update_type === "message_created";
}

/**
 * Превращает событие MAX в сообщение канала.
 *
 * Возвращает `null`, если событие не несёт сообщения: другой тип события,
 * отсутствие `chat_id`, отсутствие текста или идентификатора сообщения.
 */
export async function normalizeMaxUpdate(
  update: MaxUpdate,
  options: NormalizeOptions = {},
): Promise<NormalizedMessage | null> {
  if (!isMessageCreated(update)) {
    return null;
  }

  const chatId = update.message?.recipient?.chat_id;
  const text = update.message?.body?.text;
  const messageId = update.message?.body?.mid;

  if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
    return null;
  }
  if (typeof messageId !== "string" || messageId.length === 0) {
    return null;
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  const conversationId = conversationIdFor(String(chatId));
  const masked = options.mask ? await options.mask(text, conversationId) : null;

  return {
    conversationId,
    messageId,
    channel: "max",
    externalChatId: String(chatId),
    text: masked ? masked.maskedText : text,
    maskedFieldsCount: masked ? masked.maskedFieldsCount : 0,
  };
}
