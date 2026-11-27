/**
 * Текст клиенту при эскалации (решение владельца от 27.11.2026).
 *
 * Клиенту уходит одна фраза без причин и подробностей. Настоящая причина
 * остаётся в очереди менеджера и в трассе: клиенту не нужны ни проценты
 * полномочий агента, ни внутренние правила.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as chatRoute } from "@/app/api/chat/route";
import { setModelClient } from "@/core/model";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

const TENANT_SLUG = "test-escalation-text-01";

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
  await testPool().query(
    "DELETE FROM escalations WHERE tenant_id = $1",
    [tenantId],
  );
  process.env.ESCALATION_MODE = "notice";
});

/** Модель, отвечающая заданным текстом. */
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
        citations: [],
        tokensIn: 1,
        tokensOut: 1,
        costRub: 0,
        model: "stub",
      };
    },
  };
}

describe("текст клиенту при эскалации", () => {
  it("клиент получает одну фразу без причин и процентов", async () => {
    setModelClient(stubModel("Запрошенная скидка 10% выше полномочий агента (до 5%)."));

    const response = await chatRoute(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message: {
            client_message_id: crypto.randomUUID(),
            text: "Какую скидку 10% вы дадите?",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      escalation: { reason: string; summary: string } | null;
    };

    expect(body.outcome).toBe("escalate");
    const summary = body.escalation?.summary ?? "";
    expect(summary).toContain("передал ваш вопрос менеджеру");
    // Внутренних деталей в тексте клиенту нет.
    expect(summary).not.toContain("10%");
    expect(summary).not.toContain("5%");
    expect(summary).not.toContain("полномочий");
    // Причина остаётся доступной менеджеру.
    expect(body.escalation?.reason).toBe("policy_denied");
  });

  it("менеджер в очереди видит настоящую причину", async () => {
    setModelClient(stubModel("Запрошенная скидка 10% выше полномочий агента (до 5%)."));

    await chatRoute(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message: {
            client_message_id: crypto.randomUUID(),
            text: "Какую скидку 10% вы дадите?",
          },
        }),
      }),
    );

    const rows = await testPool().query<{ summary: string }>(
      "SELECT summary FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.summary).toContain("10%");
  });
});
