import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { createArticleDraft } from "@/modules/article-drafts";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Интеграционный тест среза 04: менеджер создаёт черновик статьи из
 * материалов диалога, дожидается явного одобрения, и только после этого
 * статья становится доступна поиску базы знаний.
 *
 * Команда проверки: npm run test -- tests/integration/04-article-draft-review.test.ts
 *
 * Модель подменяется на границе: реальных ключей у среза нет, поэтому
 * проверяется поведение среза, а не живой вызов провайдера.
 */
const TENANT_SLUG = "test-integration-04";

let tenantId = "";

/** Подготовка диалога: источник, из которого менеджер собирает статью. */
type DialogFixture = {
  conversationId: string;
  messageIds: string[];
};

async function seedDialog(): Promise<DialogFixture> {
  const conversation = await testPool().query<{ id: string }>(
    "INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id",
    [tenantId],
  );
  const conversationId = conversation.rows[0]?.id ?? "";

  const messages = await testPool().query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked)
     VALUES
       ($1, $2, gen_random_uuid(), 'client', 'Квота обновления лицензии продлевается автоматически'),
       ($1, $2, gen_random_uuid(), 'client', 'Подскажите порядок продления')
     RETURNING id`,
    [tenantId, conversationId],
  );

  return { conversationId, messageIds: messages.rows.map((row) => row.id) };
}

describe("04 — черновики статей из материалов диалога", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
  });

  afterAll(async () => {
    await closePool();
  });

  it("AC1: менеджер создаёт черновик из сообщений диалога и видит статус ожидания", async () => {
    const dialog = await seedDialog();

    const draft = await createArticleDraft({
      tenantId,
      actor: "manager-1",
      conversationId: dialog.conversationId,
      sourceMessageIds: dialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: "Квота обновления лицензии продлевается автоматически после оплаты.",
    });

    expect(draft.status).toBe("pending_review");
    expect(draft.conversationId).toBe(dialog.conversationId);
    expect(draft.sourceMessageIds).toEqual(dialog.messageIds);
    expect(draft.sourceExcerpt).toContain("Квота обновления");
    expect(draft.title).toBe("Продление квоты лицензии");

    const row = await testPool().query<{
      status: string;
      conversation_id: string;
      source_message_ids: string[];
      source_excerpt: string;
      owner: string;
    }>(
      `SELECT status, conversation_id, source_message_ids, source_excerpt, owner
       FROM kb_articles WHERE id = $1`,
      [draft.id],
    );
    expect(row.rows[0]?.status).toBe("pending_review");
    expect(row.rows[0]?.conversation_id).toBe(dialog.conversationId);
    expect(row.rows[0]?.source_message_ids).toEqual(dialog.messageIds);
    expect(row.rows[0]?.source_excerpt).toContain("Квота обновления");
    expect(row.rows[0]?.owner).toBe("manager-1");
  });
});
