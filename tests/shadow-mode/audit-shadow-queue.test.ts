import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { recordManagerQueue, recordShadowDraft } from "@/core/shadow-mode";
import type { ShadowPool } from "@/core/shadow-mode";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Идемпотентность записи очереди менеджера (аудит C17).
 *
 * Запись очереди должна быть одной на один результат ядра: повторная
 * доставка хода раньше создавала вторую строку, и менеджер видел один и тот
 * же вопрос дважды.
 *
 * Вторая часть находки: при сбое вставки функция возвращала
 * `randomUUID()`, которого в базе нет, — клиент получал ссылку на
 * несуществующую запись очереди. Идентификатор должен либо соответствовать
 * существующей строке, либо запись должна падать с ошибкой.
 */

const TENANT_SLUG = "test-audit-shadow-queue";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let tenantId = "";
let conversationId = "";

/**
 * Один и тот же теневой черновик: диалог, трасса и содержимое совпадают.
 */
function shadowDraft() {
  return {
    tenantId,
    conversationId,
    channel: "web" as const,
    summary: "Ответ подготовлен в режиме тени и не отправлен клиенту.",
    result: "Электронная лицензия выдаётся в течение 120 минут после оплаты.",
    sources: [
      {
        kind: "kb_article",
        id: "11111111-2222-4333-8444-555555555555",
        title: "Лицензирование",
        location: "https://docs.softline.com/licensing",
      },
    ],
    traceRef: conversationId,
  };
}

/** Записи очереди одного диалога: их количество и содержимое. */
async function queueRows(conversation: string): Promise<
  Array<{ id: string; reason: string; result: string; is_shadow: boolean }>
> {
  const rows = await testPool().query<{
    id: string;
    reason: string;
    result: string;
    is_shadow: boolean;
  }>(
    "SELECT id, reason, result, is_shadow FROM escalations WHERE tenant_id = $1 AND conversation_id = $2",
    [tenantId, conversation],
  );
  return rows.rows;
}

describe("идемпотентность записи очереди менеджера", () => {
  beforeAll(async () => {
    await ensureSchema();
    tenantId = await resetTenant(TENANT_SLUG);
  });

  beforeEach(async () => {
    // Свой диалог на каждый тест: счётчик записей очереди не зависит от
    // порядка выполнения тестов.
    const conversation = await testPool().query<{ id: string }>(
      `INSERT INTO conversations (id, tenant_id, channel, status)
       VALUES (gen_random_uuid(), $1, 'web', 'open') RETURNING id`,
      [tenantId],
    );
    conversationId = conversation.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * Повторная доставка того же хода не должна создавать вторую строку в
   * очереди: менеджер увидел бы один и тот же вопрос дважды.
   */
  it("повторная запись того же теневого черновика не создаёт вторую строку", async () => {
    const first = await recordShadowDraft(testPool(), shadowDraft());
    const second = await recordShadowDraft(testPool(), shadowDraft());

    const rows = await queueRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first);

    // Повторная запись возвращает идентификатор существующей записи, а не
    // новый: ссылка в ответе остаётся рабочей.
    expect(second).toBe(first);
  });

  /**
   * Возвращённый идентификатор всегда соответствует строке в базе.
   */
  it("возвращённый идентификатор существует в очереди", async () => {
    const id = await recordShadowDraft(testPool(), shadowDraft());

    const rows = await queueRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.result).toBe(shadowDraft().result);
  });

  /**
   * Сбой вставки не превращается в успех: функция не возвращает
   * идентификатор, которого нет в базе.
   */
  it("при сбое вставки не возвращает несуществующий идентификатор", async () => {
    const brokenPool: ShadowPool = {
      query: async () => ({ rows: [] }),
    };

    const outcome = await recordShadowDraft(brokenPool, shadowDraft()).then(
      (id) => ({ resolved: id }),
      (error: unknown) => ({
        failed: error instanceof Error ? error : new Error(String(error)),
      }),
    );

    expect(outcome).toHaveProperty("failed");
    if (!("failed" in outcome)) {
      throw new Error("запись очереди не упала, а вернула идентификатор");
    }
    // Выдуманного идентификатора в ошибке тоже быть не должно.
    expect(outcome.failed.message).not.toMatch(UUID_PATTERN);
  });

  /**
   * Ошибка базы пробрасывается наружу, а не подменяется «успешной» записью.
   */
  it("ошибка базы пробрасывается наружу", async () => {
    const brokenPool: ShadowPool = {
      query: async () => {
        throw new Error("соединение потеряно");
      },
    };

    await expect(recordShadowDraft(brokenPool, shadowDraft())).rejects.toThrow(
      "соединение потеряно",
    );
  });

  /**
   * Разные результаты ядра в одном диалоге — разные записи: идемпотентность
   * не должна схлопывать очередь.
   */
  it("разные результаты в одном диалоге дают разные записи", async () => {
    const first = await recordShadowDraft(testPool(), shadowDraft());
    const second = await recordShadowDraft(testPool(), {
      ...shadowDraft(),
      result: "Другой подготовленный ответ.",
    });

    expect(second).not.toBe(first);

    const rows = await queueRows(conversationId);
    expect(rows).toHaveLength(2);
  });

  /**
   * Идемпотентность обеспечивается базой: уникальный индекс по ключу
   * записи, а не только проверкой в коде.
   */
  it("в базе есть уникальный индекс идемпотентности записи очереди", async () => {
    const indexes = await testPool().query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'escalations'",
    );
    const unique = indexes.rows
      .map((row) => row.indexdef)
      .filter(
        (definition) =>
          definition.includes("UNIQUE") &&
          definition.includes("conversation_id") &&
          definition.includes("trace_ref") &&
          definition.includes("is_shadow"),
      );
    expect(unique).toHaveLength(1);
  });

  /**
   * Обычная эскалация (не из режима тени) тоже идемпотентна: её причина
   * не переписывается, а повторная запись не плодит дубли.
   */
  it("повторная запись обычной эскалации не создаёт вторую строку", async () => {
    const escalation = {
      tenantId,
      conversationId,
      channel: "web" as const,
      reason: "no_confirmed_source",
      summary: "В базе знаний нет ответа на вопрос.",
      result: "Черновик ответа менеджеру.",
      draft: "Черновик ответа менеджеру.",
      sources: [],
      traceRef: conversationId,
    };

    const first = await recordManagerQueue(testPool(), escalation);
    const second = await recordManagerQueue(testPool(), escalation);

    expect(second).toBe(first);

    const rows = await queueRows(conversationId);
    expect(rows).toHaveLength(1);
    // Причина исходной эскалации не переписана.
    expect(rows[0]?.reason).toBe("no_confirmed_source");
  });
});
