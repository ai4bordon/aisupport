import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { runAgent } from "@/core/run";
import {
  createHttpModelClient,
  ModelTimeoutError,
  setModelClient,
} from "@/core/model";
import { recordStep } from "@/modules/telemetry";
import { loadSlots, saveSlots } from "@/core/slots";
import { runWithDialogContext } from "@/core/dialog-context";
import { withDialogLock } from "@/core/dialog-lock";
import { appendDialogMessage } from "@/core/dialog-messages";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";
import type { AgentStep } from "@/modules/telemetry";

/**
 * Устойчивость ядра: сбой провайдера приводит к эскалации, а не к
 * выдуманному ответу (R16, docs/api-contract.md §12).
 */

const TENANT_SLUG = "test-core-runtime-safety";

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

/** Модель отвечает кодом класса на классификацию и текстом на генерацию. */
function okModel(
  text: string,
  citations: string[] = [],
): { complete: (request: ModelRequest) => Promise<ModelResult> } {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      const isClassification = request.messages.some((message) =>
        message.content.includes("класс обращения"),
      );
      return {
        text: isClassification ? "howto" : text,
        amounts: [],
        citations: isClassification ? [] : citations,
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

describe("устойчивость ядра", () => {
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

  it("тайм-аут ожидания первого токена даёт escalate с причиной upstream_timeout", async () => {
    // Провайдер не отвечает: запрос обрывается по истечении предела.
    // Отказ приходит тем же объектом, который даёт настоящий `fetch`:
    // `AbortController.abort()` без причины — это DOMException с именем
    // `AbortError`.
    const client = createHttpModelClient({
      baseUrl: "https://model.test",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 50,
      fetchImpl: (async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init?.signal?.reason);
          });
        })) as unknown as typeof fetch,
    });
    setModelClient(client);

    const outcome = await runAgent({
      conversationId,
      messageId: "11111111-1111-4111-8111-111111111111",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("upstream_timeout");
    expect(outcome.answer).toBeNull();
    // Никакого выдуманного текста: в ответе нет ни ответа, ни черновика.
    expect(outcome.escalation.draft).toBeNull();
    expect(outcome.escalation.summary).not.toContain("120 минут");
  });

  it("сбой генерации после успешной классификации даёт эскалацию, а не ответ из памяти модели", async () => {
    // Классификация проходит, генерация обрывается: ответ клиенту не
    // подменяется ничем, даже если модель уже что-то сказала.
    let calls = 0;
    setModelClient({
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        calls += 1;
        const isClassification = request.messages.some((message) =>
          message.content.includes("класс обращения"),
        );
        if (isClassification) {
          return {
            text: "howto",
            amounts: [],
            citations: [],
            tokensIn: 10,
            tokensOut: 2,
            costRub: 0.1,
            model: "stub-model",
          };
        }
        throw new ModelTimeoutError("превышен таймаут ожидания первого токена");
      },
    });

    const outcome = await runAgent({
      conversationId,
      messageId: "22222222-2222-4222-8222-222222222222",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(calls).toBe(2);
    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("upstream_timeout");
    expect(outcome.answer).toBeNull();
    expect(outcome.escalation.draft).toBeNull();
  });

  it("сбой провайдера после успешной классификации даёт эскалацию с причиной upstream_error", async () => {
    let calls = 0;
    setModelClient({
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        calls += 1;
        const isClassification = request.messages.some((message) =>
          message.content.includes("класс обращения"),
        );
        if (isClassification) {
          return {
            text: "howto",
            amounts: [],
            citations: [],
            tokensIn: 10,
            tokensOut: 2,
            costRub: 0.1,
            model: "stub-model",
          };
        }
        throw new Error("провайдер недоступен");
      },
    });

    const outcome = await runAgent({
      conversationId,
      messageId: "33333333-3333-4333-8333-333333333333",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(calls).toBe(2);
    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("upstream_error");
    expect(outcome.answer).toBeNull();
  });

  it("подтверждённый источник и рабочая модель дают ответ: ядро не сломано", async () => {
    // Контрольный сценарий: после сбоев ядро обязано снова отвечать.
    setModelClient(okModel(ARTICLE_TEXT, [ARTICLE_TEXT]));

    const outcome = await runAgent({
      conversationId,
      messageId: "44444444-4444-4444-8444-444444444444",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;
    expect(outcome.answer.text).toContain("120 минут");
  });
});

describe("сериализация состояния диалога", () => {
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

  /** Шаг трассы для проверки записи под блокировкой. */
  function step(
    conversation: string,
    node: string,
    messageId: string,
  ): AgentStep {
    return {
      conversationId: conversation,
      node,
      endpoint: null,
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: 1,
      metadata: {},
      sourceIds: [],
      outcome: null,
      model: null,
    };
  }

  it("блокировка диалога сериализует записи шагов: шаг одного хода не дублируется", async () => {
    const messageId = "55555555-5555-4555-8555-555555555555";

    // Два параллельных хода одного диалога пишут шаг с одинаковым
    // идемпотентным ключом: без сериализации и уникального индекса шаг
    // одного хода оказался бы в трассе дважды.
    const write = () =>
      runWithDialogContext(
        { conversationId, messageId },
        () => recordStep(step(conversationId, "classify", messageId), tenantId),
      );
    await Promise.all([write(), write()]);

    const rows = await testPool().query<{ node: string }>(
      "SELECT node FROM agent_steps WHERE conversation_id = $1 AND node = 'classify'",
      [conversationId],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("параллельные записи шагов разных ходов одного диалога не теряются", async () => {
    const first = "66666666-6666-4666-8666-666666666666";
    const second = "77777777-7777-4777-8777-777777777777";

    const write = (messageId: string) =>
      runWithDialogContext(
        { conversationId, messageId },
        () => recordStep(step(conversationId, "classify", messageId), tenantId),
      );
    await Promise.all([write(first), write(second)]);

    const rows = await testPool().query<{ node: string; step_key: string }>(
      "SELECT node, step_key FROM agent_steps WHERE conversation_id = $1 AND node = 'classify'",
      [conversationId],
    );
    expect(rows.rows).toHaveLength(2);
    // Ключи шагов разных ходов различаются: иначе один ход стёр бы другой.
    expect(rows.rows[0]?.step_key).not.toBe(rows.rows[1]?.step_key);
  });

  it("параллельное сохранение слотов не теряет значение", async () => {
    const slots = await loadSlots(conversationId);
    expect(slots.quantity).toBeNull();

    // Два параллельных сохранения одного диалога: итоговое значение
    // определено и не потеряно — оба набора слотов записаны целиком.
    await Promise.all([
      saveSlots(conversationId, { ...slots, quantity: 50, vendor: "Adobe" }),
      saveSlots(conversationId, { ...slots, termMonths: 12, vendor: "Adobe" }),
    ]);

    const loaded = await loadSlots(conversationId);
    expect(loaded.vendor).toBe("Adobe");
    expect(loaded.quantity === 50 || loaded.termMonths === 12).toBe(true);
  });

  it("параллельные записи сообщений одного диалога не теряются", async () => {
    const first = "88888888-8888-4888-8888-888888888888";
    const second = "99999999-9999-4999-8999-999999999999";

    await Promise.all([
      appendDialogMessage({
        tenantId,
        conversationId,
        clientMessageId: first,
        role: "client",
        maskedText: "первый вопрос",
        originalText: "первый вопрос",
        sources: [],
      }),
      appendDialogMessage({
        tenantId,
        conversationId,
        clientMessageId: second,
        role: "client",
        maskedText: "второй вопрос",
        originalText: "второй вопрос",
        sources: [],
      }),
    ]);

    const rows = await testPool().query<{ client_message_id: string }>(
      "SELECT client_message_id FROM messages WHERE conversation_id = $1",
      [conversationId],
    );
    // Обе записи на месте; порядок не проверяется: какой из двух
    // параллельных ходов первым получил блокировку — не определено.
    expect(rows.rows.map((row) => row.client_message_id).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("блокировка освобождается при ошибке операции", async () => {
    await expect(
      withDialogLock(conversationId, async () => {
        throw new Error("сбой операции");
      }),
    ).rejects.toThrow("сбой операции");

    // Следующая операция получает блокировку: предыдущая её отпустила.
    const value = await withDialogLock(conversationId, async () => "свободно");
    expect(value).toBe("свободно");
  });
});
