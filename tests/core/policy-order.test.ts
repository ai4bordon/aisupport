/**
 * Порядок проверки полномочий (B9).
 *
 * Узел проверки полномочий стоял после возвратов по каталогу и по «нет
 * источника»: вопрос об условиях по позиции каталога или по неопубликованной
 * статье уходил клиенту вместе со списком позиций, минуя правила политики.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setModelClient } from "@/core/model";
import { runAgent } from "@/core/run";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

const TENANT_SLUG = "test-policy-order-01";

const ARTICLE_TEXT = "Лицензия на один год стоит 1000 рублей.";

let tenantId = "";
let conversationId = "";

beforeAll(async () => {
  await ensureSchema();
  tenantId = await resetTenant(TENANT_SLUG);
});

beforeEach(async () => {
  conversationId = crypto.randomUUID();
  await testPool().query(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'web', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, tenantId],
  );
  const article = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Лицензирование', $2, 'published', now(), now())
     RETURNING id`,
    [tenantId, ARTICLE_TEXT],
  );
  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3,
       to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')
     ON CONFLICT (tenant_id, article_id, chunk_no) WHERE article_id IS NOT NULL
     DO UPDATE SET text = EXCLUDED.text,
                   search_vector = EXCLUDED.search_vector,
                   embedding = EXCLUDED.embedding,
                   embedding_model = EXCLUDED.embedding_model`,
    [tenantId, article.rows[0]?.id ?? null, ARTICLE_TEXT, `[${new Array(1536).fill(0).join(",")}]`],
  );
});

/** Модель отвечает текстом с заданной цитатой. */
function stubModel(text: string): { complete: (request: ModelRequest) => Promise<ModelResult> } {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      const prompt = request.messages.map((message) => message.content).join(" ");
      if (prompt.includes("Ответь одним кодом")) {
        return {
          text: "terms",
          amounts: [],
          citations: [],
          tokensIn: 1,
          tokensOut: 1,
          costRub: 0,
          model: "stub",
        };
      }
      return {
        text,
        amounts: [],
        citations: [ARTICLE_TEXT],
        tokensIn: 1,
        tokensOut: 1,
        costRub: 0,
        model: "stub",
      };
    },
  };
}

describe("порядок проверки полномочий", () => {
  it("скидка выше порога уходит менеджеру, а не клиенту", async () => {
    await testPool().query(
      `INSERT INTO policy_rules (tenant_id, rule_key, action, note, threshold, valid_from)
       VALUES ($1, 'discount_request', 'allow', 'Порог 5%', 5, now())`,
      [tenantId],
    );
    setModelClient(stubModel(ARTICLE_TEXT));

    const outcome = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      // Класс terms ведёт в каталог: без переноса проверки полномочий
      // ответ со списком позиций ушёл бы клиенту.
      text: "Есть ли скидка 10% на лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("policy_denied");

    await testPool().query("DELETE FROM policy_rules WHERE tenant_id = $1", [tenantId]);
  });

  it("скидка в пределах порога отвечает клиенту", async () => {
    await testPool().query(
      `INSERT INTO policy_rules (tenant_id, rule_key, action, note, threshold, valid_from)
       VALUES ($1, 'discount_request', 'allow', 'Порог 5%', 5, now())`,
      [tenantId],
    );
    setModelClient(stubModel(ARTICLE_TEXT));

    const outcome = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Есть ли скидка 3% на лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");

    await testPool().query("DELETE FROM policy_rules WHERE tenant_id = $1", [tenantId]);
  });

  it("узел проверки полномочий идёт раньше ответа по каталогу", async () => {
    await testPool().query(
      `INSERT INTO policy_rules (tenant_id, rule_key, action, note, threshold, valid_from)
       VALUES ($1, 'discount_request', 'allow', 'Порог 5%', 5, now())`,
      [tenantId],
    );
    setModelClient(stubModel(ARTICLE_TEXT));

    await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Есть ли скидка 10% на лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    const steps = await testPool().query<{ node: string }>(
      "SELECT node FROM agent_steps WHERE conversation_id = $1 ORDER BY created_at",
      [conversationId],
    );
    const nodes = steps.rows.map((row) => row.node);

    // Узел проверки полномочий обязан идти до ответа по каталогу: иначе
    // клиент получает список позиций по вопросу за скидкой.
    expect(nodes.indexOf("policy")).toBeGreaterThan(-1);
    const catalogAnswerIndex = nodes.indexOf("catalog_answer");
    if (catalogAnswerIndex > -1) {
      expect(nodes.indexOf("policy")).toBeLessThan(catalogAnswerIndex);
    }

    await testPool().query("DELETE FROM policy_rules WHERE tenant_id = $1", [tenantId]);
  });

  it("справка без коммерческих условий проверку полномочий не проходит", async () => {
    setModelClient({
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        const prompt = request.messages.map((message) => message.content).join(" ");
        if (prompt.includes("Ответь одним кодом")) {
          return {
            text: "howto",
            amounts: [],
            citations: [],
            tokensIn: 1,
            tokensOut: 1,
            costRub: 0,
            model: "stub",
          };
        }
        return {
          text: ARTICLE_TEXT,
          amounts: [],
          citations: [ARTICLE_TEXT],
          tokensIn: 1,
          tokensOut: 1,
          costRub: 0,
          model: "stub",
        };
      },
    });

    const outcome = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Как получить электронную лицензию?",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
  });
});
