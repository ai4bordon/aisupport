import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import {
  candidateFromAnswer,
  extractPromise,
  type ConfirmedSource,
  type PromiseCandidate,
} from "@/core/promise-extract";
import { recordPromise } from "@/modules/promises";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Канал доставки, адресат и маскирование адреса (R11, ADR-0018).
 *
 * В MAX адресат — диалог, и email клиента не нужен. В веб-чате адрес
 * обязателен: без него обещание не создаётся, а клиент получает вопрос
 * об адресе. Адрес — персональные данные: в модель и трассу уходит метка,
 * исходное значение лежит в таблице соответствий.
 */
const TENANT_SLUG = "test-core-promises-channel";

const SOURCE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

const SOURCES: ConfirmedSource[] = [
  { kind: "kb_article", id: "article-1", text: SOURCE_TEXT },
];

const PROMISE_LINE =
  "ОБЕЩАНИЕ: Пришлю КП | срок: 120 минут | источник: [1]";

let tenantId = "";
let conversationId = "";

function candidate(
  answerText: string,
  context: {
    channel: "web" | "max";
    externalChatId: string | null;
    clientText: string | null;
    contactEmail?: string | null;
  },
): PromiseCandidate | null {
  return candidateFromAnswer(answerText, context, SOURCES);
}

describe("канал обещания и адресат", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
    const conversation = await testPool().query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel, status)
       VALUES ($1, 'web', 'open') RETURNING id`,
      [tenantId],
    );
    conversationId = conversation.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await closePool();
  });

  it("канал MAX: адресат — диалог, адрес клиента не нужен", () => {
    const extracted = extractPromise(
      candidate(PROMISE_LINE, {
        channel: "max",
        externalChatId: "chat-42",
        clientText: null,
      })!,
      SOURCES,
    );

    expect(extracted.kind).toBe("promise");
    if (extracted.kind !== "promise") return;
    expect(extracted.promise.channel).toBe("max");
    expect(extracted.promise.externalChatId).toBe("chat-42");
    expect(extracted.promise.contactEmail).toBeNull();
    expect(extracted.promise.contactLabel).toBeNull();
  });

  it("канал веб: адрес клиента обязателен, без него обещание не создаётся", () => {
    const extracted = extractPromise(
      candidate(PROMISE_LINE, {
        channel: "web",
        externalChatId: null,
        clientText: null,
      })!,
      SOURCES,
    );

    expect(extracted.kind).toBe("rejected");
    if (extracted.kind !== "rejected") return;
    expect(extracted.reason).toBe("contact_email_required");
  });

  it("канал веб с адресом: обещание получает канал email и адресата", () => {
    const extracted = extractPromise(
      candidate(PROMISE_LINE, {
        channel: "web",
        externalChatId: null,
        clientText: null,
        contactEmail: "client@example.com",
      })!,
      SOURCES,
    );

    expect(extracted.kind).toBe("promise");
    if (extracted.kind !== "promise") return;
    expect(extracted.promise.channel).toBe("email");
    expect(extracted.promise.contactEmail).toBe("client@example.com");
    expect(extracted.promise.externalChatId).toBeNull();
  });

  it("некорректный адрес отклоняется с кодом invalid_contact_email", () => {
    const extracted = extractPromise(
      candidate(PROMISE_LINE, {
        channel: "web",
        externalChatId: null,
        clientText: null,
        contactEmail: "client@@example",
      })!,
      SOURCES,
    );

    expect(extracted.kind).toBe("rejected");
    if (extracted.kind !== "rejected") return;
    expect(extracted.reason).toBe("invalid_contact_email");
  });

  it("адрес из текста клиента попадает в обещание меткой, а не исходным значением", () => {
    const extracted = extractPromise(
      candidate(PROMISE_LINE, {
        channel: "web",
        externalChatId: null,
        clientText: "Пришлите на ⟦EMAIL_1⟧",
        contactEmail: "client@example.com",
      })!,
      SOURCES,
    );

    expect(extracted.kind).toBe("promise");
    if (extracted.kind !== "promise") return;
    expect(extracted.promise.contactLabel).toBe("⟦EMAIL_1⟧");
    expect(extracted.promise.text).not.toContain("client@example.com");
  });

  it("запись в promises хранит канал, адресата и метку адреса", async () => {
    const record = await recordPromise({
      tenantId,
      conversationId,
      text: "Счёт будет отправлен на ⟦EMAIL_1⟧ до 12.03.2026",
      dueAt: "2026-03-12T12:00:00.000Z",
      owner: "manager",
      sourceKind: "kb_article",
      sourceId: "article-1",
      channel: "email",
      contactEmail: "client@example.com",
      contactLabel: "⟦EMAIL_1⟧",
      externalChatId: null,
    });

    expect(record.channel).toBe("email");
    expect(record.contactEmail).toBe("client@example.com");
    expect(record.contactLabel).toBe("⟦EMAIL_1⟧");
    expect(record.externalChatId).toBeNull();

    const maxRecord = await recordPromise({
      tenantId,
      conversationId,
      text: "КП будет готово до 12.03.2026, пришлю сюда",
      dueAt: "2026-03-12T12:00:00.000Z",
      owner: "manager",
      sourceKind: "kb_article",
      sourceId: "article-1",
      channel: "max",
      externalChatId: "chat-42",
    });

    expect(maxRecord.channel).toBe("max");
    expect(maxRecord.externalChatId).toBe("chat-42");
    expect(maxRecord.contactEmail).toBeNull();
  });

  it("адрес клиента лежит в таблице соответствий, а не в тексте обещания", async () => {
    const record = await recordPromise({
      tenantId,
      conversationId,
      text: "Счёт будет отправлен на ⟦EMAIL_1⟧ до 12.03.2026",
      dueAt: "2026-03-12T12:00:00.000Z",
      owner: "manager",
      channel: "email",
      contactEmail: "client@example.com",
      contactLabel: "⟦EMAIL_1⟧",
    });

    await testPool().query(
      `INSERT INTO conversation_mask (conversation_id, label, value)
       VALUES ($1, $2, $3)`,
      [conversationId, "⟦EMAIL_1⟧", "client@example.com"],
    );

    const mask = await testPool().query<{ value: string }>(
      "SELECT value FROM conversation_mask WHERE conversation_id = $1 AND label = $2",
      [conversationId, "⟦EMAIL_1⟧"],
    );
    expect(mask.rows[0]?.value).toBe("client@example.com");

    // В тексте обещания исходного адреса нет.
    const stored = await testPool().query<{ text: string }>(
      "SELECT text FROM promises WHERE id = $1",
      [record.id],
    );
    expect(stored.rows[0]?.text).not.toContain("client@example.com");
  });
});
