import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool } from "@/db/pool";
import {
  createHttpModelClient,
  FIRST_TOKEN_TIMEOUT_SECONDS,
  ModelTimeoutError,
  ModelUnavailableError,
  RETRY_AFTER_429_SECONDS,
} from "@/core/model";
import {
  DIALOG_TIMEOUT_MS,
  MODEL_CALL_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  runAgent,
} from "@/core/run";
import { setModelClient } from "@/core/model";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

/**
 * Пределы времени и повтор модели (docs/api-contract.md §10, R16).
 *
 * Проверки детерминированные: время подменяется, ожидания реальных
 * 120 и 30 секунд не происходит.
 */

const TENANT_SLUG = "test-core-model-runtime";

const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

let tenantId = "";
let conversationId = "";

/** Вектор статьи: совпадает с детерминированным провайдером по тем же словам. */
function articleEmbedding(): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const word of ["Электронная", "лицензия", "предоставляется"]) {
    const stem = word.toLowerCase().slice(0, 6);
    let hash = 2166136261;
    for (let index = 0; index < stem.length; index += 1) {
      hash ^= stem.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % 1536] = (vector[Math.abs(hash) % 1536] ?? 0) + 1;
  }
  return vector;
}

/** Ответ провайдера: текст без JSON-обёртки. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Модель отвечает кодом класса на классификацию и текстом на генерацию. */
function capturingModel(
  requests: ModelRequest[],
  text = ARTICLE_TEXT,
): { complete: (request: ModelRequest) => Promise<ModelResult> } {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(request);
      const isClassification = request.messages.some((message) =>
        message.content.includes("класс обращения"),
      );
      return {
        text: isClassification ? "howto" : text,
        amounts: [],
        citations: isClassification ? [] : [ARTICLE_TEXT],
        tokensIn: 10,
        tokensOut: 5,
        costRub: 0.1,
        model: "stub-model",
      };
    },
  };
}

async function seedConversation(): Promise<void> {
  tenantId = await resetTenant(TENANT_SLUG);

  const article = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Лицензирование', $2, 'published', now(), now())
     RETURNING id`,
    [tenantId, ARTICLE_TEXT],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [tenantId, article.rows[0]?.id ?? "", ARTICLE_TEXT, `[${articleEmbedding().join(",")}]`],
  );

  const conversation = await testPool().query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id`,
    [tenantId],
  );
  conversationId = conversation.rows[0]?.id ?? "";
}

describe("пределы времени ядра", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    process.env.ESCALATION_MODE = "on";
    await seedConversation();
  });

  afterAll(async () => {
    await closePool();
  });

  it("лимиты времени совпадают с контрактом", () => {
    expect(FIRST_TOKEN_TIMEOUT_SECONDS).toBe(120);
    expect(RETRY_AFTER_429_SECONDS).toBe(30);
    expect(STEP_TIMEOUT_MS).toBe(5_000);
    expect(MODEL_CALL_TIMEOUT_MS).toBe(120_000);
    expect(DIALOG_TIMEOUT_MS).toBe(300_000);
  });

  it("клиент модели обрывает ожидание первого токена через 120 секунд", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }) as unknown as typeof fetch;

      const client = createHttpModelClient({
        baseUrl: "https://model.test",
        apiKey: "test-key",
        model: "test-model",
        fetchImpl,
      });

      const pending = client.complete({ messages: [{ role: "user", content: "вопрос" }] });
      const settled = expect(pending).rejects.toBeInstanceOf(ModelTimeoutError);
      settled.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(signals[0]?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("повтор после 429 получает свой предел ожидания первого токена", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let calls = 0;
      let secondCallStarted!: () => void;
      const secondStarted = new Promise<void>((resolve) => {
        secondCallStarted = resolve;
      });

      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        calls += 1;
        if (calls === 1) {
          return new Response("busy", { status: 429 });
        }
        secondCallStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }) as unknown as typeof fetch;

      const sleeps: number[] = [];
      const client = createHttpModelClient({
        baseUrl: "https://model.test",
        apiKey: "test-key",
        model: "test-model",
        fetchImpl,
        // Пауза перед повтором занимает реальное время тестовых часов:
        // иначе предел повтора и предел первого вызова совпали бы.
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
          await vi.advanceTimersByTimeAsync(milliseconds);
        },
      });

      const pending = client.complete({ messages: [{ role: "user", content: "вопрос" }] });
      const settled = expect(pending).rejects.toBeInstanceOf(ModelTimeoutError);
      settled.catch(() => undefined);

      await secondStarted;
      expect(calls).toBe(2);
      expect(sleeps).toEqual([RETRY_AFTER_429_SECONDS * 1000]);

      // Повтор начался на 30-й секунде: его предел — 150-я секунда, а не
      // 120-я (предел первого вызова).
      await vi.advanceTimersByTimeAsync(90_000);
      expect(signals[1]?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("второй 429 даёт ровно два вызова, одну паузу и ModelUnavailableError", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("busy", { status: 429 });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const client = createHttpModelClient({
      baseUrl: "https://model.test",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(
      client.complete({ messages: [{ role: "user", content: "вопрос" }] }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);

    expect(calls).toBe(2);
    expect(sleeps).toEqual([RETRY_AFTER_429_SECONDS * 1000]);
  });

  it("429, затем успех: два вызова, одна пауза и ответ второго ответа", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("busy", { status: 429 });
      }
      return jsonResponse({
        choices: [{ message: { content: "Готово" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const client = createHttpModelClient({
      baseUrl: "https://model.test",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "вопрос" }],
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([RETRY_AFTER_429_SECONDS * 1000]);
    expect(result.text).toBe("Готово");
    expect(result.tokensIn).toBe(3);
    expect(result.tokensOut).toBe(4);
  });

  it("классификация и генерация получают только замаскированный текст", async () => {
    const requests: ModelRequest[] = [];
    setModelClient(capturingModel(requests));

    const outcome = await runAgent({
      conversationId,
      messageId: "11111111-1111-4111-8111-111111111111",
      channel: "web",
      externalChatId: null,
      text: "⟦PERSON_1⟧ спрашивает про лицензию для ⟦EMAIL_1⟧",
      maskedFieldsCount: 2,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
    // Порядок узлов: сначала классификация, потом генерация.
    expect(requests).toHaveLength(2);
    const classification = requests[0];
    const generation = requests[1];
    expect(classification?.messages.some((message) => message.content.includes("класс обращения"))).toBe(true);
    expect(generation?.messages.some((message) => message.content.includes("Подтверждённые источники"))).toBe(true);

    const seen = requests
      .flatMap((request) => request.messages.map((message) => message.content))
      .join("\n");

    // В модель уходят только метки: исходных значений в запросе нет.
    expect(seen).toContain("⟦PERSON_1⟧");
    expect(seen).toContain("⟦EMAIL_1⟧");
    expect(seen).not.toContain("Иванов Иванович");
    expect(seen).not.toContain("ivanov@example.test");

    // Текст источников не содержит таблицы соответствий меток.
    const sourceContext = generation?.messages
      .map((message) => message.content)
      .find((content) => content.includes("Подтверждённые источники"));
    expect(sourceContext).toBeTruthy();
    expect(sourceContext).not.toContain("Иванов Иванович");
    expect(sourceContext).not.toContain("ivanov@example.test");
  });
});
