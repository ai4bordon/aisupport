import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import {
  chatDeliveryAgreement,
  documentPromiseQuestion,
  listPromises,
  recordDocumentPromise,
  resolveContactEmail,
  validateContactEmail,
  PromiseValidationError,
  type PromiseDocumentKind,
  type PromiseTerm,
} from "@/modules/promises";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Обещание по заказанному документу: клиент даёт адрес, адрес проверяется,
 * обещание попадает в журнал обещаний (S5).
 *
 * Сценарий: менеджер заказал КП или счёт → клиенту показано подтверждение
 * «КП подготовим в течение 15 минут. На какой email отправить?» → клиент
 * ввёл адрес → адрес проверен → запись в журнале с каналом `email`, адресом,
 * сроком, ответственным `manager` и статусом `open`.
 *
 * Запасной путь: клиент отказался от адреса → доставка ссылкой в чат,
 * канал `max`, адрес не нужен.
 *
 * Писем модуль не отправляет: ни SMTP, ни CRM, ни MAX из модуля не
 * вызываются, `reminded_at` не заполняется.
 */
const TENANT_SLUG = "test-promises-email";

/** Срок из подтверждения: «в течение 15 минут». */
const TERM: PromiseTerm = { minutes: 15 };

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

describe("обещание по документу с адресом получателя", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    await seedConversation();
  });

  afterAll(async () => {
    await closePool();
  });

  it("подтверждение клиенту называет документ, срок и спрашивает адрес", () => {
    const question = documentPromiseQuestion("quote", TERM);

    expect(question).toBe("КП подготовим в течение 15 минут. На какой email отправить?");
  });

  it("запись с каналом email хранит адрес, срок и owner", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "quote",
      term: TERM,
      owner: "manager",
      delivery: { kind: "email", email: "client@example.com" },
    });

    expect(record.channel).toBe("email");
    expect(record.contactEmail).toBe("client@example.com");
    expect(record.owner).toBe("manager");
    expect(record.status).toBe("open");
    expect(record.conversationId).toBe(conversationId);
    expect(record.tenantId).toBe(tenantId);

    // Срок задан в днях/часах/минутах, а в журнале лежит момент срока.
    const dueAt = new Date(record.dueAt).getTime();
    const createdAt = new Date(record.createdAt).getTime();
    expect(dueAt).toBeGreaterThan(createdAt);
    expect(dueAt - createdAt).toBeLessThanOrEqual(15 * 60 * 1000 + 60_000);
  });

  it("срок в днях попадает в журнал как момент срока", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "invoice",
      term: { days: 2 },
      owner: "manager",
      delivery: { kind: "email", email: "client@example.com" },
    });

    const dueAt = new Date(record.dueAt).getTime();
    const createdAt = new Date(record.createdAt).getTime();
    expect(dueAt - createdAt).toBeGreaterThan(2 * 24 * 60 * 60 * 1000 - 60_000);
    expect(dueAt - createdAt).toBeLessThanOrEqual(2 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it("текст обещания содержит метку адреса, а не сырой адрес", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "quote",
      term: TERM,
      owner: "manager",
      delivery: { kind: "email", email: "client@example.com" },
    });

    expect(record.text).not.toContain("client@example.com");
    expect(record.text).toContain(record.contactLabel ?? "");
    expect(record.contactLabel).toBe("⟦EMAIL_1⟧");
  });

  it("адрес восстанавливается по метке из таблицы соответствий", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "quote",
      term: TERM,
      owner: "manager",
      delivery: { kind: "email", email: "client@example.com" },
    });

    const restored = await resolveContactEmail(conversationId, record.contactLabel ?? "");
    expect(restored).toBe("client@example.com");
  });

  it("запись видна в списке обещаний", async () => {
    await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "quote",
      term: TERM,
      owner: "manager",
      delivery: { kind: "email", email: "client@example.com" },
    });

    const all = await listPromises({ tenantId });
    expect(all).toHaveLength(1);
    expect(all[0]?.channel).toBe("email");
    expect(all[0]?.contactEmail).toBe("client@example.com");
    expect(all[0]?.owner).toBe("manager");
    expect(all[0]?.status).toBe("open");

    const emailOnly = await listPromises({ tenantId, channel: "email" });
    expect(emailOnly).toHaveLength(1);
  });

  it("неверный адрес отклоняется и запись не создаётся", async () => {
    await expect(
      recordDocumentPromise({
        tenantId,
        conversationId,
        documentKind: "quote",
        term: TERM,
        owner: "manager",
        delivery: { kind: "email", email: "client@@example" },
      }),
    ).rejects.toBeInstanceOf(PromiseValidationError);

    const all = await listPromises({ tenantId });
    expect(all).toHaveLength(0);
  });

  it("ошибка неверного адреса объясняется по-русски", async () => {
    const cases: Array<{ email: string; fragment: string }> = [
      { email: "clientexample.com", fragment: "«@»" },
      { email: "client@example", fragment: "точки" },
      { email: "@example.com", fragment: "«@»" },
    ];

    for (const item of cases) {
      const validation = validateContactEmail(item.email);
      expect(validation.ok).toBe(false);
      if (validation.ok) continue;
      expect(validation.error).toContain(item.fragment);
      // Ошибка читается человеку: кириллица и подсказка формата.
      expect(validation.error).toMatch(/[А-Яа-яЁё]/u);
      expect(validation.error).toContain("client@example.com");
    }
  });

  it("пустой адрес отклоняется с понятным объяснением", async () => {
    const validation = validateContactEmail("   ");
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.error).toContain("client@example.com");
  });

  it("корректный адрес принимается", () => {
    const validation = validateContactEmail(" client@example.com ");
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.email).toBe("client@example.com");
  });

  it("неверный срок отклоняется", async () => {
    await expect(
      recordDocumentPromise({
        tenantId,
        conversationId,
        documentKind: "quote",
        term: { minutes: 0 },
        owner: "manager",
        delivery: { kind: "email", email: "client@example.com" },
      }),
    ).rejects.toBeInstanceOf(PromiseValidationError);

    const all = await listPromises({ tenantId });
    expect(all).toHaveLength(0);
  });

  it("ответственный по умолчанию — менеджер", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "quote",
      term: TERM,
      delivery: { kind: "email", email: "client@example.com" },
    });

    expect(record.owner).toBe("manager");
  });
});

describe("запасной путь: ссылка в чат", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    await seedConversation();
  });

  afterAll(async () => {
    await closePool();
  });

  it("клиент отказался от адреса: обещание пишется с каналом max и без адреса", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "quote",
      term: TERM,
      owner: "manager",
      delivery: { kind: "chat", externalChatId: "chat-42" },
    });

    expect(record.channel).toBe("max");
    expect(record.contactEmail).toBeNull();
    expect(record.contactLabel).toBeNull();
    expect(record.externalChatId).toBe("chat-42");
    expect(record.owner).toBe("manager");
    expect(record.status).toBe("open");
    expect(record.text).toContain("чат");
  });

  it("запасной путь виден в списке обещаний", async () => {
    await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "invoice",
      term: TERM,
      owner: "manager",
      delivery: { kind: "chat", externalChatId: "chat-42" },
    });

    const all = await listPromises({ tenantId });
    expect(all).toHaveLength(1);
    expect(all[0]?.channel).toBe("max");
    expect(all[0]?.contactEmail).toBeNull();

    const maxOnly = await listPromises({ tenantId, channel: "max" });
    expect(maxOnly).toHaveLength(1);
  });

  it("формулировка запасного пути называет ссылку в чат", () => {
    expect(chatDeliveryAgreement("quote", TERM)).toBe(
      "КП подготовим в течение 15 минут, пришлю ссылку в чат.",
    );
  });

  it("счёт в запасном пути называется счётом", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "invoice",
      term: { days: 1 },
      owner: "manager",
      delivery: { kind: "chat" },
    });

    expect(record.text).toContain("счёт");
  });
});

describe("журнал обещаний: срок, ответственный и адрес в базе", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    await seedConversation();
  });

  afterAll(async () => {
    await closePool();
  });

  it("в таблице promises лежат канал, адрес, метка и срок", async () => {
    const record = await recordDocumentPromise({
      tenantId,
      conversationId,
      documentKind: "quote",
      term: TERM,
      owner: "manager",
      delivery: { kind: "email", email: "client@example.com" },
    });

    const rows = await testPool().query<{
      channel: string;
      contact_email: string | null;
      contact_label: string | null;
      owner: string;
      status: string;
      due_at: Date;
      reminded_at: Date | null;
    }>(
      `SELECT channel, contact_email, contact_label, owner, status, due_at, reminded_at
         FROM promises WHERE id = $1`,
      [record.id],
    );

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row?.channel).toBe("email");
    expect(row?.contact_email).toBe("client@example.com");
    expect(row?.contact_label).toBe("⟦EMAIL_1⟧");
    expect(row?.owner).toBe("manager");
    expect(row?.status).toBe("open");
    expect(row?.due_at.toISOString()).toBe(record.dueAt);
    // Внешних напоминаний нет: модуль ничего не отправляет.
    expect(row?.reminded_at).toBeNull();
  });

  it("вид документа не влияет на поля записи, но попадает в текст", async () => {
    const kinds: PromiseDocumentKind[] = ["quote", "invoice"];
    for (const kind of kinds) {
      const record = await recordDocumentPromise({
        tenantId,
        conversationId,
        documentKind: kind,
        term: TERM,
        owner: "manager",
        delivery: { kind: "email", email: "client@example.com" },
      });

      expect(record.channel).toBe("email");
      expect(record.contactEmail).toBe("client@example.com");
      expect(record.owner).toBe("manager");
    }
  });
});
