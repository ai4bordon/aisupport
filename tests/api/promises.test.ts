import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { GET, POST } from "@/app/api/promises/route";
import { POST as markDone } from "@/app/api/promises/[id]/done/route";
import { listPromises, markPromiseDone } from "@/modules/promises";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Журнал обещаний менеджера (docs/api-contract.md §3, R11, ADR-0018).
 *
 * Журнал перечисляет открытые, выполненные и просроченные обещания с
 * явными каналом и адресатом. Реальной отправки писем нет: менеджер видит
 * обещание и отмечает «отправил» руками.
 */
const TENANT_SLUG = "test-api-promises";

let tenantId = "";
let conversationId = "";

async function seedConversation(): Promise<void> {
  tenantId = await resetTenant(TENANT_SLUG);
  const conversation = await testPool().query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, status)
     VALUES ($1, 'web', 'open') RETURNING id`,
    [tenantId],
  );
  conversationId = conversation.rows[0]?.id ?? "";
}

describe("GET /promises — журнал обещаний", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    await seedConversation();
  });

  afterAll(async () => {
    await closePool();
  });

  it("отдаёт канал и адресат у каждой записи", async () => {
    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status,
          source_kind, source_id, channel, contact_email, contact_label, external_chat_id)
       VALUES
         ($1, $2, 'Счёт будет отправлен на ⟦EMAIL_1⟧ до 27.12.2026', now() + interval '10 days',
          'manager', 'open', 'kb_article', 'article-1', 'email', 'client@example.com', '⟦EMAIL_1⟧', NULL),
         ($1, $2, 'КП будет готово до 27.12.2026, пришлю сюда', now() + interval '20 days',
          'manager', 'open', 'kb_article', 'article-1', 'max', NULL, NULL, 'chat-42')`,
      [tenantId, conversationId],
    );

    const response = await GET(new Request("http://localhost/api/promises"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      promises: Array<{
        id: string;
        channel: string;
        contact: string | null;
        owner: string;
        status: string;
        origin: string;
      }>;
    };

    expect(body.promises).toHaveLength(2);
    const email = body.promises.find((item) => item.channel === "email");
    expect(email?.contact).toBe("client@example.com");
    expect(email?.owner).toBe("manager");
    expect(email?.status).toBe("open");
    expect(email?.origin).toBe("подтверждённый источник");

    const max = body.promises.find((item) => item.channel === "max");
    expect(max?.contact).toBe("chat-42");
  });

  it("просроченная запись попадает в группу overdue и помечается признаком просрочки", async () => {
    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel)
       VALUES ($1, $2, 'КП будет готово до 01.01.2026', now() - interval '1 day',
          'manager', 'open', 'max')`,
      [tenantId, conversationId],
    );

    const response = await GET(new Request("http://localhost/api/promises"));
    const body = (await response.json()) as {
      promises: Array<{ status: string; overdue: boolean }>;
    };

    expect(body.promises).toHaveLength(1);
    expect(body.promises[0]?.status).toBe("overdue");
    expect(body.promises[0]?.overdue).toBe(true);

    // Просрочка зафиксирована в базе, а не вычисляется на лету в ответе.
    const stored = await testPool().query<{ status: string }>(
      "SELECT status FROM promises WHERE conversation_id = $1",
      [conversationId],
    );
    expect(stored.rows[0]?.status).toBe("overdue");
  });

  it("синтетическая запись помечена «синтетический/демонстрационный»", async () => {
    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, is_synthetic, channel)
       VALUES ($1, $2, 'Демонстрационная запись', now() + interval '1 day',
          'manager', 'open', true, 'max')`,
      [tenantId, conversationId],
    );

    const response = await GET(new Request("http://localhost/api/promises"));
    const body = (await response.json()) as {
      promises: Array<{ origin: string; is_synthetic: boolean }>;
    };

    expect(body.promises[0]?.origin).toBe("синтетический/демонстрационный");
    expect(body.promises[0]?.is_synthetic).toBe(true);
  });

  it("фильтр по статусу отбирает записи группы", async () => {
    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel)
       VALUES
         ($1, $2, 'Открытое', now() + interval '10 days', 'manager', 'open', 'max'),
         ($1, $2, 'Выполнено', now() + interval '10 days', 'manager', 'done', 'max')`,
      [tenantId, conversationId],
    );

    const response = await GET(
      new Request("http://localhost/api/promises?status=done"),
    );
    const body = (await response.json()) as {
      promises: Array<{ status: string }>;
    };

    expect(body.promises).toHaveLength(1);
    expect(body.promises[0]?.status).toBe("done");
  });

  it("менеджер отмечает «отправил»: статус меняется на done", async () => {
    const inserted = await testPool().query<{ id: string }>(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel)
       VALUES ($1, $2, 'КП будет готово до 27.12.2026', now() + interval '10 days',
          'manager', 'open', 'max')
       RETURNING id`,
      [tenantId, conversationId],
    );
    const id = inserted.rows[0]?.id ?? "";

    const response = await markDone(
      new Request(`http://localhost/api/promises/${id}/done`, { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("done");

    const stored = await testPool().query<{ status: string }>(
      "SELECT status FROM promises WHERE id = $1",
      [id],
    );
    expect(stored.rows[0]?.status).toBe("done");
  });

  it("журнал изолирован по tenant_id", async () => {
    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel)
       VALUES ($1, $2, 'Открытое', now() + interval '10 days', 'manager', 'open', 'max')`,
      [tenantId, conversationId],
    );

    const otherTenantId = await resetTenant("test-api-promises-other");
    const other = await testPool().query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel, status)
       VALUES ($1, 'web', 'open') RETURNING id`,
      [otherTenantId],
    );
    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel)
       VALUES ($1, $2, 'Чужое', now() + interval '10 days', 'manager', 'open', 'max')`,
      [otherTenantId, other.rows[0]?.id ?? ""],
    );

    // Возвращаем slug основного арендатора: маршрут определяет арендатора
    // сервером, а не из тела запроса.
    process.env.TENANT_SLUG = TENANT_SLUG;

    const response = await GET(new Request("http://localhost/api/promises"));
    const body = (await response.json()) as { promises: Array<{ text: string }> };

    expect(body.promises).toHaveLength(1);
    expect(body.promises[0]?.text).toBe("Открытое");
  });

  it("у всех записей reminded_at остаётся NULL: внешних напоминаний нет", async () => {
    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel)
       VALUES ($1, $2, 'Открытое', now() + interval '10 days', 'manager', 'open', 'max')`,
      [tenantId, conversationId],
    );

    await GET(new Request("http://localhost/api/promises"));

    const rows = await testPool().query<{ reminded_at: Date | null }>(
      "SELECT reminded_at FROM promises WHERE conversation_id = $1",
      [conversationId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.reminded_at).toBeNull();
  });

  it("модуль отмечает выполненным и перечисляет записи по фильтру", async () => {
    const inserted = await testPool().query<{ id: string }>(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel)
       VALUES ($1, $2, 'Открытое', now() + interval '10 days', 'manager', 'open', 'max')
       RETURNING id`,
      [tenantId, conversationId],
    );

    const changed = await markPromiseDone(inserted.rows[0]?.id ?? "", tenantId);
    expect(changed).toBe(true);

    const done = await listPromises({ tenantId, status: "done" });
    expect(done).toHaveLength(1);
    expect(done[0]?.status).toBe("done");
  });
});
