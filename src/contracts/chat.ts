import { z } from "zod";

/**
 * Контракт веб-чата (docs/api-contract.md §4).
 *
 * Провенанс: JSON в snake_case, внутренние типы — в camelCase.
 * Преобразование выполняется на границе HTTP.
 */

/** Источник, на который опирается ответ. */
export type Source = {
  kind: "kb_article" | "kb_document";
  id: string;
  title: string;
  location: string | null;
  /** Текст источника: нужен валидатору для проверки цитат. */
  text: string;
};

export type ChatRequest = {
  conversation_id: string;
  message: {
    client_message_id: string;
    text: string;
  };
};

export type ChatEscalation = {
  id: string;
  reason: string;
  summary: string;
  draft: string | null;
};

export type ChatResponse = {
  conversation_id: string;
  message_id: string;
  outcome: "respond" | "escalate";
  answer: {
    text: string;
    sources: Array<{
      kind: "kb_article" | "kb_document";
      id: string;
      title: string;
      location: string | null;
    }>;
  } | null;
  escalation: ChatEscalation | null;
  trace: {
    steps: number;
    tokens: number;
    cost_rub: number;
  };
};

const UuidSchema = z.uuid();

export const ChatRequestSchema = z.object({
  conversation_id: UuidSchema,
  message: z.object({
    client_message_id: UuidSchema,
    text: z.string().min(1).max(4000),
  }),
});

export const ChatSourceSchema = z.object({
  kind: z.enum(["kb_article", "kb_document"]),
  id: UuidSchema,
  title: z.string(),
  location: z.string().nullable(),
});

export const ChatResponseSchema = z.object({
  conversation_id: UuidSchema,
  message_id: UuidSchema,
  outcome: z.enum(["respond", "escalate"]),
  answer: z
    .object({
      text: z.string(),
      sources: z.array(ChatSourceSchema),
    })
    .nullable(),
  escalation: z
    .object({
      id: UuidSchema,
      reason: z.string(),
      summary: z.string(),
      draft: z.string().nullable(),
    })
    .nullable(),
  trace: z.object({
    steps: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    cost_rub: z.number().nonnegative(),
  }),
});

/** Тело ошибки по docs/api-contract.md §2. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
    request_id: z.string(),
  }),
});
