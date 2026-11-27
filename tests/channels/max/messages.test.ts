/**
 * Запись переписки канала MAX (B18).
 *
 * Канал MAX писал только трассу, но не `messages`: лента канала на экране
 * демо, история диалога в кабинете менеджера и идемпотентная ветка веб-чаты
 * показывали пустоту при живом общении.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { createMessageRecorder, deterministicUuid } from "@/channels/max/messages";
import { ensureSchema, resetTenant, testPool } from "../../db/helpers";

const TENANT_SLUG = "test-max-messages-01";

let tenantId = "";

beforeAll(async () => {
  await ensureSchema();
  tenantId = await resetTenant(TENANT_SLUG);
});

/**
 * Диалог для записи сообщений.
 *
 * Таблица `messages` ссылается на `conversations`, поэтому диалог должен
 * существовать: иначе запись отклоняется внешним ключом.
 */
async function createConversation(conversationId: string): Promise<void> {
  await testPool().query(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'max', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, tenantId],
  );
}

describe("идентификатор сообщения MAX", () => {
  it("одинаковый mid даёт одинаковый uuid", () => {
    expect(deterministicUuid("mid.abc123")).toBe(deterministicUuid("mid.abc123"));
  });

  it("разные mid дают разные uuid", () => {
    expect(deterministicUuid("mid.abc123")).not.toBe(deterministicUuid("mid.abc124"));
  });

  it("uuid имеет корректный формат", () => {
    expect(deterministicUuid("mid.abc123")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("запись переписки MAX", () => {
  it("реплика клиента и ответ агента попадают в таблицу", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    await createConversation(conversationId);
    const record = createMessageRecorder(testPool());

    await record({
      tenantId,
      conversationId,
      messageId: "mid.client.1",
      role: "client",
      text: "Сколько стоит лицензия?",
    });
    await record({
      tenantId,
      conversationId,
      messageId: "answer:mid.client.1",
      role: "agent",
      text: "Лицензия стоит 1000 ₽.",
      sources: [{ kind: "catalog_product", id: "1", title: "Лицензия" }],
    });

    const rows = await testPool().query<{ role: string; text_masked: string }>(
      "SELECT role, text_masked FROM messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY role",
      [tenantId, conversationId],
    );

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.role).sort()).toEqual(["agent", "client"]);
  });

  it("повтор того же сообщения не создаёт вторую строку", async () => {
    const conversationId = "22222222-2222-4222-8222-222222222222";
    await createConversation(conversationId);
    const record = createMessageRecorder(testPool());

    await record({
      tenantId,
      conversationId,
      messageId: "mid.repeat.1",
      role: "client",
      text: "Повтор",
    });
    await record({
      tenantId,
      conversationId,
      messageId: "mid.repeat.1",
      role: "client",
      text: "Повтор",
    });

    const rows = await testPool().query<{ count: string }>(
      "SELECT count(*) FROM messages WHERE tenant_id = $1 AND conversation_id = $2",
      [tenantId, conversationId],
    );

    expect(Number(rows.rows[0]?.count ?? "0")).toBe(1);
  });

  it("реплика клиента и ответ агента с одним mid не схлопываются", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    await createConversation(conversationId);
    const record = createMessageRecorder(testPool());

    await record({
      tenantId,
      conversationId,
      messageId: "mid.same",
      role: "client",
      text: "Вопрос",
    });
    await record({
      tenantId,
      conversationId,
      messageId: "answer:mid.same",
      role: "agent",
      text: "Ответ",
    });

    const rows = await testPool().query<{ count: string }>(
      "SELECT count(*) FROM messages WHERE tenant_id = $1 AND conversation_id = $2",
      [tenantId, conversationId],
    );

    expect(Number(rows.rows[0]?.count ?? "0")).toBe(2);
  });

  it("сырой текст клиента не сохраняется в text_original", async () => {
    const conversationId = "44444444-4444-4444-8444-444444444444";
    await createConversation(conversationId);
    const record = createMessageRecorder(testPool());

    await record({
      tenantId,
      conversationId,
      messageId: "mid.pii.1",
      role: "client",
      text: "Пишите на client@example.com",
    });

    const rows = await testPool().query<{ text_original: string | null }>(
      "SELECT text_original FROM messages WHERE tenant_id = $1 AND conversation_id = $2",
      [tenantId, conversationId],
    );

    expect(rows.rows[0]?.text_original).toBeNull();
  });
});
