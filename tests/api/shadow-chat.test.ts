import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { POST } from "@/app/api/chat/route";
import { setModelClient } from "@/core/model";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

/**
 * Режим тени в веб-чате (ADR-0008, R10).
 *
 * При включённой тени клиент не получает ответ агента: проверенный ответ
 * сохраняется черновиком в очереди менеджера, а в ответе HTTP остаётся
 * технический `outcome=escalate` с `answer=null`.
 */

const TENANT_SLUG = "test-shadow-chat";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

let tenantId = "";

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Заглушка модели: классификатор отвечает кодом класса, генератор — текстом
 * ответа со ссылкой на источник.
 */
function okModel(text: string, citations: string[] = []): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
} {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
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
      return {
        text,
        amounts: [],
        citations,
        tokensIn: 10,
        tokensOut: 20,
        costRub: 0.1,
        model: "stub-model",
      };
    },
  };
}

function embeddingFor(words: string[]): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const word of words) {
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

async function seedArticle(): Promise<void> {
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
    [
      tenantId,
      article.rows[0]?.id ?? "",
      ARTICLE_TEXT,
      `[${embeddingFor(["Электронная", "лицензия", "предоставляется"]).join(",")}]`,
    ],
  );
}

describe("POST /v1/chat в режиме тени", () => {
  beforeAll(async () => {
    process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-key";
    process.env.TENANT_SLUG = TENANT_SLUG;
    await ensureSchema();
  });

  beforeEach(async () => {
    process.env.ESCALATION_MODE = "on";
    await seedArticle();
    setModelClient(okModel(ARTICLE_TEXT, [ARTICLE_TEXT]));
  });

  afterAll(async () => {
    await closePool();
  });

  it("не отправляет ответ клиенту и сохраняет черновик в очереди менеджера", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);

    const conversationId = "3a1b2c3d-1111-4111-8111-111111111111";
    const response = await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: "3a1b2c3d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      answer: { text: string } | null;
      escalation: { reason: string; draft: string | null } | null;
    };

    // Клиент ответа не получает: технический результат — эскалация.
    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();
    expect(body.escalation?.draft).toContain("120 минут");

    // В переписке нет сообщения агента с клиентским текстом ответа.
    const agentMessages = await testPool().query<{ text_masked: string }>(
      "SELECT text_masked FROM messages WHERE tenant_id = $1 AND role = 'agent'",
      [tenantId],
    );
    expect(agentMessages.rows).toHaveLength(0);
  });

  it("создаёт запись очереди с каналом, диалогом, причиной, результатом и ссылкой на трассу", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);

    const conversationId = "4a1b2c3d-1111-4111-8111-111111111111";
    await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: "4a1b2c3d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    const queue = await testPool().query<{
      channel: string;
      conversation_id: string;
      reason: string;
      result: string;
      draft: string | null;
      trace_ref: string;
    }>("SELECT * FROM escalations WHERE tenant_id = $1", [tenantId]);

    expect(queue.rows).toHaveLength(1);
    const record = queue.rows[0];
    expect(record?.channel).toBe("web");
    expect(record?.conversation_id).toBe(conversationId);
    expect(record?.reason).toBe("shadow_mode");
    expect(record?.result).not.toBe("");
    expect(record?.result).toContain("120 минут");
    expect(record?.draft).toBe(record?.result);
    expect(record?.trace_ref).toBe(conversationId);
  });

  it("при выключенной тени обычный ответ сохраняется как раньше", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);

    const response = await POST(
      chatRequest({
        conversation_id: "5a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "5a1b2c3d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    const body = (await response.json()) as {
      outcome: string;
      answer: { text: string } | null;
    };
    expect(body.outcome).toBe("respond");
    expect(body.answer?.text).toContain("120 минут");

    const agentMessages = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE tenant_id = $1 AND role = 'agent'",
      [tenantId],
    );
    expect(Number(agentMessages.rows[0]?.count ?? "0")).toBe(1);

    const queue = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(queue.rows[0]?.count ?? "0")).toBe(0);
  });
});
