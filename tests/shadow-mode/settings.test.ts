import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { isShadowMode, recordShadowDraft } from "@/core/shadow-mode";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Хранение режима тени и записи очереди менеджера.
 *
 * Настройка режима тени одна на оба канала и лежит в `tenants.shadow_mode`
 * (ADR-0008, R10). Дублирующее поле `channel_state.shadow_mode` удаляется:
 * два источника истины рано или поздно разошлись бы, и веб-чат с MAX
 * показывали бы разные значения.
 *
 * Запись очереди — это строка `escalations` с каналом, диалогом, причиной,
 * результатом и безопасной ссылкой на трассу.
 */

const TENANT_SLUG = "test-shadow-mode";

let tenantId = "";
let otherTenantId = "";
let conversationId = "";

describe("режим тени: хранение настройки", () => {
  beforeAll(async () => {
    await ensureSchema();
    tenantId = await resetTenant(TENANT_SLUG);
    otherTenantId = await resetTenant(`${TENANT_SLUG}-other`);
  });

  afterAll(async () => {
    await closePool();
  });

  it("читает режим тени из tenants по арендатору", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [otherTenantId]);

    expect(await isShadowMode(testPool(), tenantId)).toBe(true);
    expect(await isShadowMode(testPool(), otherTenantId)).toBe(false);
  });

  it("значение режима тени изолировано по арендатору", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [otherTenantId]);

    expect(await isShadowMode(testPool(), tenantId)).toBe(false);
    expect(await isShadowMode(testPool(), otherTenantId)).toBe(true);

    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [otherTenantId]);
  });

  it("дублирующее поле channel_state.shadow_mode отсутствует", async () => {
    const columns = await testPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'channel_state' AND column_name = 'shadow_mode'`,
    );
    expect(columns.rows).toHaveLength(0);
  });
});

describe("режим тени: запись очереди менеджера", () => {
  beforeAll(async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);
    const conversation = await testPool().query<{ id: string }>(
      `INSERT INTO conversations (id, tenant_id, channel, status)
       VALUES (gen_random_uuid(), $1, 'web', 'open') RETURNING id`,
      [tenantId],
    );
    conversationId = conversation.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);
  });

  it("запись очереди принимает канал, результат и безопасную ссылку на трассу", async () => {
    const id = await recordShadowDraft(testPool(), {
      tenantId,
      conversationId,
      channel: "web",
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
    });

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const row = await testPool().query<{
      reason: string;
      summary: string;
      result: string;
      draft: string | null;
      channel: string;
      conversation_id: string;
      trace_ref: string;
      sources: Array<Record<string, unknown>>;
      status: string;
    }>("SELECT * FROM escalations WHERE id = $1", [id]);

    const record = row.rows[0];
    expect(record?.channel).toBe("web");
    expect(record?.conversation_id).toBe(conversationId);
    expect(record?.reason).toBe("shadow_mode");
    expect(record?.result).toContain("120 минут");
    expect(record?.draft).toBe(record?.result);
    expect(record?.trace_ref).toBe(conversationId);
    expect(record?.status).toBe("open");
    // В источниках — только безопасные метаданные: текст источника в очередь
    // не попадает.
    expect(record?.sources).toHaveLength(1);
    expect(record?.sources[0]).not.toHaveProperty("text");
  });

  it("запись очереди другого арендатора не видна текущему", async () => {
    const visible = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM escalations WHERE tenant_id = $1",
      [otherTenantId],
    );
    expect(Number(visible.rows[0]?.count ?? "0")).toBe(0);
  });

  /**
   * Отключение режима не трогает уже созданные записи очереди: менеджер
   * должен видеть, что было подготовлено в тени, даже когда режим выключили.
   */
  it("отключение режима не удаляет ранее созданные записи очереди", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);
    const id = await recordShadowDraft(testPool(), {
      tenantId,
      conversationId,
      channel: "web",
      summary: "Черновик подготовлен в режиме тени.",
      result: "Черновик ответа.",
      sources: [],
      traceRef: conversationId,
    });

    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);

    expect(await isShadowMode(testPool(), tenantId)).toBe(false);

    const row = await testPool().query<{ status: string; result: string }>(
      "SELECT status, result FROM escalations WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.status).toBe("open");
    expect(row.rows[0]?.result).toBe("Черновик ответа.");
  });

  /**
   * Настройка не кэшируется: следующая обработка видит новое значение без
   * перезапуска процесса. Иначе отключение режима не действовало бы до
   * перезапуска сервера.
   */
  it("переключение режима видно следующей обработке без перезапуска", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);
    const before = await isShadowMode(testPool(), tenantId);

    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);
    const after = await isShadowMode(testPool(), tenantId);

    expect(before).toBe(true);
    expect(after).toBe(false);
  });
});
