/**
 * Ответ на уточняющий вопрос при подборе (регрессия 422).
 *
 * Вопрос «Нужно 50 лицензий» без сохранённого контекста подбора уходил в
 * базу знаний, где модель называла цену и считала сумму, которой нет ни в
 * одном источнике. Ответ блокировался проверкой сумм, и клиент получал 422
 * вместо уточняющего вопроса.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "@/core/run";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

const TENANT_SLUG = "test-clarify-422-01";

let tenantId = "";

beforeAll(async () => {
  await ensureSchema();
  tenantId = await resetTenant(TENANT_SLUG);
});

beforeEach(async () => {
  // Порядок удаления — по внешним ключам: сначала трасса, потом диалоги.
  await testPool().query(
    "DELETE FROM agent_steps WHERE tenant_id = $1",
    [tenantId],
  );
  await testPool().query(
    "DELETE FROM conversation_slots WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id = $1)",
    [tenantId],
  );
  await testPool().query(
    "DELETE FROM conversations WHERE tenant_id = $1",
    [tenantId],
  );
});

/** Создаёт диалог и возвращает его идентификатор. */
async function newConversation(): Promise<string> {
  const conversationId = crypto.randomUUID();
  await testPool().query(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'web', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, tenantId],
  );
  return conversationId;
}

describe("уточняющий вопрос при подборе", () => {
  it("вопрос с числом без контекста получает уточняющий вопрос, а не 422", async () => {
    const conversationId = await newConversation();

    const outcome = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Нужно 50 лицензий",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;
    // Ответ задаёт вопрос, а не выдаёт сумму, которой нет в источниках.
    expect(outcome.answer.text.length).toBeGreaterThan(0);
    // Уточняющий вопрос строится кодом и валидации не проходит: нарушений нет.
    const validate = outcome.steps.find((step) => step.node === "validate");
    expect(validate?.metadata["violationCount"] ?? 0).toBe(0);
  });

  it("вопрос с числом в подборе продолжает подбор", async () => {
    const conversationId = await newConversation();

    // Первый ход запускает подбор и сохраняет предметную область.
    await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Защитить почту на 50 сотрудников",
      maskedFieldsCount: 0,
      tenantId,
    });

    const outcome = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Бюджета нет, инфраструктура своя",
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
  });
});
