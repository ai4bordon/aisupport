import type { AgentOutcome, NormalizedMessage } from "./types";

/**
 * Тонкий клиент ядра по замороженному контракту `docs/api-contract.md` §5.
 *
 * Срезы волны 1 не импортируют код друг друга: MAX-канал получает ядро по
 * HTTP-контракту `POST /agent/run`. Форма запроса и ответа — как в контракте:
 * тело snake_case, ответ с полями контракта.
 */

export type CoreClientOptions = {
  /** Адрес сервиса ядра, например `http://127.0.0.1:3000`. */
  baseUrl: string;
  /** Своя реализация `fetch` — используется в тестах. */
  fetch?: typeof globalThis.fetch;
};

/** Тело запроса `/agent/run` — `docs/api-contract.md` §5. */
export type AgentRunRequest = {
  conversation_id: string;
  message_id: string;
  channel: "web" | "max";
  external_chat_id: string | null;
  text: string;
  masked_fields_count: number;
};

/**
 * Преобразует нормализованное сообщение в тело `/agent/run`.
 */
export function toAgentRunRequest(message: NormalizedMessage): AgentRunRequest {
  return {
    conversation_id: message.conversationId,
    message_id: message.messageId,
    channel: message.channel,
    external_chat_id: message.externalChatId,
    text: message.text,
    masked_fields_count: message.maskedFieldsCount,
  };
}

export function createCoreClient(options: CoreClientOptions): {
  runAgent: (input: NormalizedMessage) => Promise<AgentOutcome>;
} {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/agent/run`;

  return {
    async runAgent(input: NormalizedMessage): Promise<AgentOutcome> {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toAgentRunRequest(input)),
      });
      if (!response.ok) {
        throw new Error(`ядро ответило статусом ${response.status}`);
      }
      const payload = (await response.json()) as AgentOutcome;
      if (payload.outcome !== "respond" && payload.outcome !== "escalate") {
        throw new Error("ядро вернуло неизвестный результат");
      }
      return payload;
    },
  };
}
