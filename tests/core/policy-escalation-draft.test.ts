/**
 * Черновик менеджера при отказе по полномочиям.
 *
 * Отказ по скидке уходил менеджеру без черновика: в очереди обращений было
 * видно только причину, и менеджеру приходилось начинать с нуля. Теперь в
 * очереди лежит черновик: агент предлагает предел скидки, который он может
 * оформить сам, а больший — согласует с руководителем.
 *
 * Процент в черновике берётся из результата проверки полномочий: запрошенный
 * клиентом и порог правила. Поэтому тест проверяет два случая: порог
 * встроенного правила (5%) и порог правила арендатора (7%) — с константой
 * в ядре второй случай дал бы неверный черновик.
 *
 * Черновик клиенту не уходит: клиент получает прежнее уведомление о
 * передаче вопроса менеджеру.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { POST as chatRoute } from "@/app/api/chat/route";
import { setModelClient } from "@/core/model";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

const TENANT_SLUG = "test-policy-escalation-draft";

const ARTICLE_TEXT = "Лицензия на один год стоит 1000 рублей.";

let tenantId = "";
let conversationId = "";

/**
 * Модель-заглушка: на классификацию отвечает классом `terms`, на генерацию —
 * текстом статьи. Настоящие ключи у среза нет, проверяется поведение ядра.
 */
function stubModel(text: string): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
} {
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

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Запись правила арендатора: порог скидки агента.
 *
 * Порог задаётся записью правила, а не константой в тесте: черновик должен
 * называть тот порог, который задал арендатор.
 */
async function setDiscountRule(threshold: number): Promise<void> {
  await testPool().query(
    `INSERT INTO policy_rules (tenant_id, rule_key, action, note, threshold, valid_from)
     VALUES ($1, 'discount_request', 'allow', 'Порог скидки агента', $2, now())`,
    [tenantId, threshold],
  );
}

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "test-session-secret-policy-draft";
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
  await testPool().query("DELETE FROM escalations WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM policy_rules WHERE tenant_id = $1", [tenantId]);
  // Режим эскалации `on`: отказ по полномочиям создаёт запись в очереди
  // менеджера (ADR-0014).
  process.env.ESCALATION_MODE = "on";
  setModelClient(stubModel(ARTICLE_TEXT));
});

afterAll(async () => {
  await closePool();
});

describe("черновик менеджера при отказе по полномочиям", () => {
  it("в очереди лежит непустой черновик с процентом", async () => {
    await setDiscountRule(5);

    const response = await chatRoute(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: crypto.randomUUID(),
          text: "Какую скидку 10% вы дадите на лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      answer: unknown;
      escalation: { reason: string; summary: string; draft: string | null } | null;
    };

    // Итог остаётся эскалацией: черновик не превращает отказ в ответ.
    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();
    expect(body.escalation?.reason).toBe("policy_denied");

    const rows = await testPool().query<{ draft: string | null; reason: string }>(
      "SELECT draft, reason FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );

    expect(rows.rows).toHaveLength(1);
    const draft = rows.rows[0]?.draft ?? "";
    expect(draft).not.toBe("");
    // Процент назван в черновике: менеджер видит предел скидки агента.
    expect(draft).toContain("5%");
  });

  it("черновик предлагает оформить скидку в пределах полномочий", async () => {
    await setDiscountRule(5);

    await chatRoute(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: crypto.randomUUID(),
          text: "Какую скидку 10% вы дадите на лицензию?",
        },
      }),
    );

    const rows = await testPool().query<{ draft: string | null }>(
      "SELECT draft FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );

    const draft = rows.rows[0]?.draft ?? "";
    expect(draft).toContain("могу оформить");
    expect(draft).toContain("согласую с руководителем");
  });

  it("процент черновика берётся из правила арендатора, а не из константы", async () => {
    // Порог 7% задаёт арендатор: черновик должен называть именно его, иначе
    // менеджеру показан чужой предел скидки.
    await setDiscountRule(7);

    await chatRoute(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: crypto.randomUUID(),
          text: "Какую скидку 10% вы дадите на лицензию?",
        },
      }),
    );

    const rows = await testPool().query<{ draft: string | null }>(
      "SELECT draft FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );

    const draft = rows.rows[0]?.draft ?? "";
    expect(draft).toContain("7%");
    expect(draft).not.toContain("5%");
  });

  it("запрошенный клиентом процент попадает в черновик", async () => {
    await setDiscountRule(5);

    await chatRoute(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: crypto.randomUUID(),
          text: "Какую скидку 12% вы дадите на лицензию?",
        },
      }),
    );

    const rows = await testPool().query<{ draft: string | null }>(
      "SELECT draft FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );

    const draft = rows.rows[0]?.draft ?? "";
    expect(draft).toContain("12%");
    expect(draft).toContain("5%");
  });

  it("правило без порога не выдумывает процент в черновике", async () => {
    // Правило запрещает скидки целиком: порога у него нет, и называть в
    // черновике предел скидки было бы выдумкой — менеджер увидел бы число,
    // которого никто не подтверждал.
    await testPool().query(
      `INSERT INTO policy_rules (tenant_id, rule_key, action, note, threshold, valid_from)
       VALUES ($1, 'discount_request', 'escalate', 'Скидки не подтверждены', NULL, now())`,
      [tenantId],
    );

    const response = await chatRoute(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: crypto.randomUUID(),
          text: "Какую скидку 10% вы дадите на лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      escalation: { reason: string } | null;
    };
    expect(body.outcome).toBe("escalate");
    expect(body.escalation?.reason).toBe("policy_denied");

    const rows = await testPool().query<{ draft: string | null }>(
      "SELECT draft FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );

    const draft = rows.rows[0]?.draft ?? "";
    expect(draft).not.toBe("");
    expect(draft).not.toContain("могу оформить");
  });

  it("черновик клиенту не уходит: клиент получает прежнее уведомление", async () => {
    await setDiscountRule(5);

    const response = await chatRoute(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: crypto.randomUUID(),
          text: "Какую скидку 10% вы дадите на лицензию?",
        },
      }),
    );

    const body = (await response.json()) as {
      outcome: string;
      answer: unknown;
      escalation: { summary: string; draft: string | null } | null;
    };

    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();
    const summary = body.escalation?.summary ?? "";
    expect(summary).toContain("передал ваш вопрос менеджеру");
    // Внутренние проценты клиенту не показываются (решение владельца
    // от 27.11.2026).
    expect(summary).not.toContain("5%");
    expect(summary).not.toContain("10%");
  });
});
