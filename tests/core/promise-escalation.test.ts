import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { runAgent } from "@/core/run";
import { setModelClient } from "@/core/model";
import { setEmbeddingProvider } from "@/modules/knowledge";
import {
  candidateFromAnswer,
  extractPromise,
  type ConfirmedSource,
} from "@/core/promise-extract";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelClient, ModelResult } from "@/core/model";

/**
 * Неподтверждённый срок → эскалация вместо обещания (R11, ADR-0014).
 *
 * Обещание не создаётся, клиенту не уходит ни срок, ни ответственный, ни
 * формулировка «мы сделаем» — вместо этого вопрос уходит менеджеру.
 */
const TENANT_SLUG = "test-core-promises-escalation";

const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

const SOURCES: ConfirmedSource[] = [
  { kind: "kb_article", id: "article-1", text: ARTICLE_TEXT },
];

let tenantId = "";
let conversationId = "";

function embeddingFor(words: string[]): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const word of words) {
    const index = Math.abs(
      [...word.toLowerCase()].reduce((sum, ch) => sum + ch.charCodeAt(0), 0),
    ) % 1536;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  return vector;
}

function okModel(text: string): ModelClient {
  return {
    complete: async (): Promise<ModelResult> => ({
      text,
      amounts: [],
      citations: [],
      tokensIn: 1,
      tokensOut: 1,
      costRub: 0,
      model: "stub",
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

  const embedding = embeddingFor(["Электронная", "лицензия", "предоставляется"]);

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [tenantId, article.rows[0]?.id ?? "", ARTICLE_TEXT, `[${embedding.join(",")}]`],
  );

  const conversation = await testPool().query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id`,
    [tenantId],
  );
  conversationId = conversation.rows[0]?.id ?? "";
}

describe("неподтверждённый срок ведёт к эскалации", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    process.env.ESCALATION_MODE = "on";
    setEmbeddingProvider({
      model: "deterministic-hash-v1",
      embed: async (text: string) => embeddingFor(text.split(/\s+/u)),
    });
    await seedConversation();
  });

  afterAll(async () => {
    await closePool();
  });

  it("подтверждённый срок даёт запись в promises с провенансом источника", async () => {
    setModelClient(
      okModel(
        "Электронная лицензия предоставляется в течение 120 минут после оплаты.\n" +
          "ОБЕЩАНИЕ: Пришлю счёт в течение 120 минут | срок: 120 минут | источник: [1]",
      ),
    );

    const outcome = await runAgent({
      conversationId,
      messageId: "55555555-5555-4555-8555-555555555555",
      channel: "max",
      externalChatId: "chat-1",
      text: "Когда придёт лицензия?",
      maskedFieldsCount: 0,
      tenantId,
    });

    const promises = await testPool().query<{
      text: string;
      owner: string;
      status: string;
      source_kind: string | null;
      source_id: string | null;
      is_synthetic: boolean;
    }>(
      `SELECT text, owner, status, source_kind, source_id, is_synthetic
         FROM promises WHERE conversation_id = $1`,
      [conversationId],
    );

    expect(promises.rows).toHaveLength(1);
    // Формулировку обязательства сохраняет модель, а код добавляет только
    // то, чего модель знать не могла: подтверждённый срок и адресата. Раньше
    // текст переписывался шаблоном кода («КП будет готово…»), и смысл
    // обязательства терялся (ADR-0019, C18).
    expect(promises.rows[0]?.text).toBe("Пришлю счёт в течение 120 минут");
    expect(promises.rows[0]?.owner).toBe("manager");
    expect(promises.rows[0]?.status).toBe("open");
    expect(promises.rows[0]?.source_kind).toBe("kb_article");
    expect(promises.rows[0]?.is_synthetic).toBe(false);

    // Строка-маркер обязательства клиенту не показывается.
    if (outcome.outcome === "respond") {
      expect(outcome.answer.text).not.toContain("ОБЕЩАНИЕ:");
    }
  });

  it("срок, которого нет в источниках, отклоняется кодом", () => {
    const candidate = candidateFromAnswer(
      "ОБЕЩАНИЕ: Отправим КП за 15 минут | срок: 15 минут | источник: [1]",
      { channel: "max", externalChatId: "chat-1", clientText: null },
      SOURCES,
    );

    expect(candidate).not.toBeNull();
    const extraction = extractPromise(candidate!, SOURCES);
    expect(extraction.kind).toBe("rejected");
    if (extraction.kind !== "rejected") return;
    expect(extraction.reason).toBe("deadline_not_in_source");
  });

  it("ядро эскалирует и не создаёт записей в promises", async () => {
    setModelClient(
      okModel("ОБЕЩАНИЕ: Отправим КП за 15 минут | срок: 15 минут | источник: [1]"),
    );

    const outcome = await runAgent({
      conversationId,
      messageId: "11111111-1111-4111-8111-111111111111",
      channel: "max",
      externalChatId: "chat-1",
      text: "Когда придёт КП?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("no_confirmed_source");
    expect(outcome.answer).toBeNull();

    const promises = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM promises WHERE conversation_id = $1",
      [conversationId],
    );
    expect(promises.rows[0]?.count).toBe("0");
  });

  it("клиенту не уходит ни срок, ни ответственный, ни «мы сделаем»", async () => {
    setModelClient(
      okModel("ОБЕЩАНИЕ: Отправим КП за 15 минут | срок: 15 минут | источник: [1]"),
    );

    const outcome = await runAgent({
      conversationId,
      messageId: "22222222-2222-4222-8222-222222222222",
      channel: "max",
      externalChatId: "chat-1",
      text: "Когда придёт КП?",
      maskedFieldsCount: 0,
      tenantId,
    });

    const trace = outcome.steps
      .map((step) => JSON.stringify(step.metadata))
      .join(" ");
    expect(trace).not.toContain("15 минут");

    if (outcome.outcome === "respond") {
      expect(outcome.answer.text).not.toContain("15 минут");
      expect(outcome.answer.text).not.toContain("Отправим КП");
    }
  });

  it("в режиме notice клиент получает нейтральное уведомление без срока", async () => {
    process.env.ESCALATION_MODE = "notice";
    setModelClient(
      okModel("ОБЕЩАНИЕ: Отправим КП за 15 минут | срок: 15 минут | источник: [1]"),
    );

    const outcome = await runAgent({
      conversationId,
      messageId: "33333333-3333-4333-8333-333333333333",
      channel: "max",
      externalChatId: "chat-1",
      text: "Когда придёт КП?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("no_confirmed_source");
    expect(outcome.escalation.draft ?? "").not.toContain("15 минут");
  });

  it("в режиме off очередь менеджера не создаётся, но обещание не отправляется", async () => {
    process.env.ESCALATION_MODE = "off";
    setModelClient(
      okModel("ОБЕЩАНИЕ: Отправим КП за 15 минут | срок: 15 минут | источник: [1]"),
    );

    const outcome = await runAgent({
      conversationId,
      messageId: "44444444-4444-4444-8444-444444444444",
      channel: "max",
      externalChatId: "chat-1",
      text: "Когда придёт КП?",
      maskedFieldsCount: 0,
      tenantId,
    });

    // Обещание в любом случае не уходит клиенту.
    if (outcome.outcome === "respond") {
      expect(outcome.answer.text).not.toContain("15 минут");
      expect(outcome.answer.text).not.toContain("Отправим КП");
    }

    const promises = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM promises WHERE conversation_id = $1",
      [conversationId],
    );
    expect(promises.rows[0]?.count).toBe("0");
  });
});
