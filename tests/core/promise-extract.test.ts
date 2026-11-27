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
 * Извлечение и запись обещания из подтверждённого источника (R11, ADR-0018).
 *
 * Ключевой инвариант: обещание допустимо только из подтверждённого источника.
 * Проверку выполняет код, а не формулировка модели: без источника, с
 * источником не из списка и со сроком, которого нет в тексте источника,
 * обещание не создаётся.
 */
const TENANT_SLUG = "test-core-promises";

const SOURCE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты. " +
  "Ответственный: менеджер по продажам.";

const SOURCES: ConfirmedSource[] = [
  { kind: "kb_article", id: "article-1", text: SOURCE_TEXT },
];

let tenantId = "";
let conversationId = "";

function maxCandidate(text: string): PromiseCandidate | null {
  return candidateFromAnswer(
    text,
    {
      channel: "max",
      externalChatId: "chat-1",
      clientText: null,
    },
    SOURCES,
  );
}

describe("извлечение обещания из подтверждённого источника", () => {
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

  it("подтверждённый срок даёт обещание с ответственным из источника", () => {
    const candidate = maxCandidate(
      "ОБЕЩАНИЕ: Обещаем отправить счёт | срок: 120 минут | источник: [1]",
    );
    expect(candidate).not.toBeNull();

    const extraction = extractPromise(candidate as PromiseCandidate, SOURCES);

    expect(extraction.kind).toBe("promise");
    if (extraction.kind !== "promise") return;
    expect(extraction.promise.sourceKind).toBe("kb_article");
    expect(extraction.promise.sourceId).toBe("article-1");
    expect(extraction.promise.owner).toBe("менеджер по продажам");
    expect(extraction.promise.text).toContain("Обещаем отправить счёт");
    expect(extraction.promise.channel).toBe("max");
    expect(extraction.promise.externalChatId).toBe("chat-1");
    expect(Number.isNaN(Date.parse(extraction.promise.dueAt))).toBe(false);
  });

  it("без источников обещание отклоняется с кодом no_confirmed_source", () => {
    const candidate = maxCandidate(
      "ОБЕЩАНИЕ: Обещаем отправить счёт | срок: 120 минут | источник: [1]",
    );

    const extraction = extractPromise(candidate as PromiseCandidate, []);

    expect(extraction.kind).toBe("rejected");
    if (extraction.kind !== "rejected") return;
    expect(extraction.reason).toBe("no_confirmed_source");
  });

  it("срок, которого нет в тексте источника, отклоняется с кодом deadline_not_in_source", () => {
    const candidate = maxCandidate(
      "ОБЕЩАНИЕ: Обещаем отправить счёт | срок: 999 минут | источник: [1]",
    );

    const extraction = extractPromise(candidate as PromiseCandidate, SOURCES);

    expect(extraction.kind).toBe("rejected");
    if (extraction.kind !== "rejected") return;
    expect(extraction.reason).toBe("deadline_not_in_source");
  });

  it("ответственный по умолчанию — manager, если источник его не называет", () => {
    const sources: ConfirmedSource[] = [
      {
        kind: "kb_article",
        id: "article-2",
        text: "Электронная лицензия предоставляется в течение 120 минут после оплаты.",
      },
    ];
    const candidate = candidateFromAnswer(
      "ОБЕЩАНИЕ: Обещаем отправить счёт | срок: 120 минут | источник: [1]",
      { channel: "max", externalChatId: "chat-1", clientText: null },
      sources,
    );

    const extraction = extractPromise(candidate as PromiseCandidate, sources);

    expect(extraction.kind).toBe("promise");
    if (extraction.kind !== "promise") return;
    expect(extraction.promise.owner).toBe("manager");
  });

  it("запись обещания сохраняет поля и изолирована по tenant_id", async () => {
    const record = await recordPromise({
      tenantId,
      conversationId,
      text: "Счёт будет отправлен до 12.03.2026",
      dueAt: "2026-03-12T12:00:00.000Z",
      owner: "менеджер по продажам",
      sourceKind: "kb_article",
      sourceId: "article-1",
    });

    expect(record.status).toBe("open");
    expect(record.isSynthetic).toBe(false);
    expect(record.sourceKind).toBe("kb_article");
    expect(record.sourceId).toBe("article-1");
    expect(record.conversationId).toBe(conversationId);

    const rows = await testPool().query<{ tenant_id: string; count: string }>(
      "SELECT tenant_id, count(*)::text AS count FROM promises WHERE id = $1 GROUP BY tenant_id",
      [record.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.tenant_id).toBe(tenantId);
  });
});
