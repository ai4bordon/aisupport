import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { runAgent } from "@/core/run";
import { setModelClient, ModelUnavailableError, ModelTimeoutError } from "@/core/model";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelClient, ModelRequest, ModelResult } from "@/core/model";

/**
 * Сценарии ядра: подтверждённый ответ либо эскалация с причиной.
 *
 * Модель подменяется на границе: реальных ключей у среза нет, поэтому
 * проверяется поведение ядра, а не живой вызов провайдера.
 *
 * Тест работает на своём арендаторе: файлы тестов идут параллельно и не
 * должны затирать фикстуры друг друга.
 */
const TENANT_SLUG = "test-core-run";

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
    const index = Math.abs(hash) % 1536;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  return vector;
}

function okModel(text: string, amounts: number[] = [], citations: string[] = []): ModelClient {
  return {
    complete: async (_request: ModelRequest): Promise<ModelResult> => ({
      text,
      amounts,
      citations,
      tokensIn: 120,
      tokensOut: 60,
      costRub: 0.5,
      model: "stub-model",
    }),
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

  const embedding = articleEmbedding();

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector)`,
    [tenantId, article.rows[0]?.id ?? "", ARTICLE_TEXT, `[${embedding.join(",")}]`],
  );

  const conversation = await testPool().query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id`,
    [tenantId],
  );
  conversationId = conversation.rows[0]?.id ?? "";
}

describe("ядро агента", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    await seedConversation();
  });

  afterAll(async () => {
    await closePool();
  });

  it("одобренный источник даёт respond со ссылкой на источник", async () => {
    setModelClient(okModel(ARTICLE_TEXT, [], [ARTICLE_TEXT]));

    const outcome = await runAgent({
      conversationId,
      messageId: "11111111-1111-4111-8111-111111111111",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;
    expect(outcome.answer.text).toContain("120 минут");
    expect(outcome.answer.sources.length).toBeGreaterThan(0);
    expect(outcome.answer.sources[0]?.title).toBe("Лицензирование");
    expect(outcome.answer.sources[0]?.location).toBeTruthy();
  });

  it("нет одобренного источника — escalate с причиной no_confirmed_source", async () => {
    setModelClient(okModel("Ответ из памяти модели."));

    const outcome = await runAgent({
      conversationId,
      messageId: "22222222-2222-4222-8222-222222222222",
      channel: "web",
      externalChatId: null,
      text: "Как настроить квантовый телепорт?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("no_confirmed_source");
    expect(outcome.answer).toBeNull();
  });

  it("policy запрещает ответ — escalate с причиной policy_denied", async () => {
    await testPool().query(
      `INSERT INTO policy_rules (tenant_id, rule_key, action, note, valid_from)
       VALUES ($1, 'discount_request', 'escalate', 'Скидки не подтверждены', now())`,
      [tenantId],
    );
    setModelClient(okModel(ARTICLE_TEXT, [], [ARTICLE_TEXT]));

    const outcome = await runAgent({
      conversationId,
      messageId: "33333333-3333-4333-8333-333333333333",
      channel: "web",
      externalChatId: null,
      // Вопрос совпадает со статьёй о лицензировании, но требует скидку —
      // правило полномочий запрещает обещать скидки без подтверждения.
      text: "Какая скидка на электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("policy_denied");
  });

  it("ошибка модели даёт escalate с причиной upstream_error", async () => {
    setModelClient({
      complete: async () => {
        throw new ModelUnavailableError("провайдер недоступен");
      },
    });

    const outcome = await runAgent({
      conversationId,
      messageId: "44444444-4444-4444-8444-444444444444",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("upstream_error");
  });

  it("таймаут даёт escalate с причиной upstream_timeout", async () => {
    setModelClient({
      complete: async () => {
        throw new ModelTimeoutError("превышен таймаут ожидания");
      },
    });

    const outcome = await runAgent({
      conversationId,
      messageId: "55555555-5555-4555-8555-555555555555",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("upstream_timeout");
  });

  it("сумма без источника даёт escalate, а трасса содержит violation amount_not_in_source", async () => {
    setModelClient(okModel("Стоимость 9999 рублей.", [9999], []));

    const outcome = await runAgent({
      conversationId,
      messageId: "66666666-6666-4666-8666-666666666666",
      channel: "web",
      externalChatId: null,
      text: "Сколько стоит лицензия?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;

    const validateStep = outcome.steps.find((step) => step.node === "validate");
    const violations = validateStep?.metadata.violations;
    expect(Array.isArray(violations)).toBe(true);
    expect((violations as string[] | undefined)?.join(",")).toContain("amount_not_in_source");
  });

  it("трасса содержит узлы classify, retrieve, validate и respond|escalate", async () => {
    setModelClient(okModel(ARTICLE_TEXT, [], [ARTICLE_TEXT]));

    const outcome = await runAgent({
      conversationId,
      messageId: "77777777-7777-4777-8777-777777777777",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    const nodes = outcome.steps.map((step) => step.node);
    expect(nodes).toContain("classify");
    expect(nodes).toContain("retrieve");
    expect(nodes).toContain("validate");
    expect(nodes.at(-1)).toBe(outcome.outcome === "respond" ? "respond" : "escalate");
  });

  it("в модель уходит только маскированный текст", async () => {
    let seen = "";
    setModelClient({
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        seen = request.messages.map((message) => message.content).join(" ");
        return { text: ARTICLE_TEXT, amounts: [], citations: [], tokensIn: 1, tokensOut: 1, costRub: 0, model: "stub" };
      },
    });

    await runAgent({
      conversationId,
      messageId: "88888888-8888-4888-8888-888888888888",
      channel: "web",
      externalChatId: null,
      text: "⟦PERSON_1⟧ спрашивает про лицензию",
      maskedFieldsCount: 1,
      tenantId,
    });

    expect(seen).toContain("⟦PERSON_1⟧");
    expect(seen).not.toContain("Иванов");
  });

  it("шаги трассы записываются в базу", async () => {
    setModelClient(okModel(ARTICLE_TEXT, [], [ARTICLE_TEXT]));

    await runAgent({
      conversationId,
      messageId: "99999999-9999-4999-8999-999999999999",
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    const steps = await testPool().query<{ node: string; source_ids: string[] }>(
      "SELECT node, source_ids FROM agent_steps WHERE conversation_id = $1 ORDER BY created_at",
      [conversationId],
    );
    expect(steps.rows.length).toBeGreaterThan(0);
    expect(steps.rows.map((row) => row.node)).toContain("retrieve");
  });
});
