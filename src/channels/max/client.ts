import { Bot } from "@maxhub/max-bot-api";
import type { ClientOptions } from "@maxhub/max-bot-api";

import type { MaxUpdate } from "./types";

/**
 * Тонкий клиент Bot API MAX.
 *
 * Транспорт спринта — Long Polling `GET /updates`; отправка ответа —
 * `POST /messages`. Webhook `POST /subscriptions` не используется: он требует
 * публичного HTTPS с доверенным TLS.
 *
 * Токен приходит в конструктор из переменной окружения и нигде не логируется:
 * в журнал попадают только обезличенные сообщения.
 */

export type MaxClient = {
  /** Long Polling: забрать пачку событий начиная с `marker`. */
  getUpdates: (
    marker: number | null,
    options?: { limit?: number; timeout?: number },
  ) => Promise<{ updates: MaxUpdate[]; marker: number }>;
  /** Отправить сообщение в чат. */
  sendMessage: (chatId: string, text: string) => Promise<void>;
};

export type MaxClientOptions = {
  /** Адрес Bot API. По умолчанию — боевой `https://platform-api2.max.ru`. */
  baseUrl?: string;
  /** Своя реализация `fetch` — используется в тестах. */
  fetch?: ClientOptions["fetch"];
};

/** Убирает токен из текста: в журналах и ошибках его быть не должно. */
export function redactToken(text: string, token: string): string {
  if (!token) {
    return text;
  }
  return text.split(token).join("[hidden]");
}

/**
 * Создаёт клиента Bot API MAX.
 *
 * Токен передаётся только сюда; наружу он не выходит.
 */
export function createMaxClient(token: string, options: MaxClientOptions = {}): MaxClient {
  const clientOptions: ClientOptions = {};
  if (options.baseUrl) {
    clientOptions.baseUrl = options.baseUrl;
  }
  if (options.fetch) {
    clientOptions.fetch = options.fetch;
  }

  const bot = new Bot(token, { clientOptions });

  return {
    async getUpdates(marker, { limit, timeout } = {}) {
      const query: { limit?: number; timeout?: number; marker?: number } = {};
      if (limit !== undefined) {
        query.limit = limit;
      }
      if (timeout !== undefined) {
        query.timeout = timeout;
      }
      if (marker !== null && marker !== undefined) {
        query.marker = marker;
      }
      try {
        const response = await bot.api.getUpdates(["message_created"], query);
        return { updates: response.updates, marker: response.marker };
      } catch (error) {
        throw new Error(
          `опрос обновлений MAX не удался: ${redactToken(describeError(error), token)}`,
          { cause: error },
        );
      }
    },

    async sendMessage(chatId, text) {
      try {
        await bot.api.sendMessageToChat(Number(chatId), text);
      } catch (error) {
        throw new Error(
          `отправка сообщения в MAX не удалась: ${redactToken(describeError(error), token)}`,
          { cause: error },
        );
      }
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
