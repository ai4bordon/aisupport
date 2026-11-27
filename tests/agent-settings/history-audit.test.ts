import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import {
  listAuditEntries,
  listTestSessions,
  readCurrentSettings,
  redactSecrets,
  runSandbox,
  updateSetting,
} from "@/modules/agent-settings";
import { setModelClient } from "@/core/model";
import { testPool } from "../db/helpers";
import { ensureSliceDatabase } from "./helpers";

/**
 * История тестовых сессий и аудит изменений настроек.
 *
 * Команда проверки:
 * `npm run test -- tests/agent-settings/history-audit.test.ts`
 */

const TENANT_SLUG = "test-agent-history-audit-08";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

describe("история песочницы и аудит настроек", () => {
  let tenantId = "";

  beforeAll(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
  });

  beforeEach(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
    process.env.OPENCODE_API_KEY = "history-secret-key-08";

    // Клиент с известной метрикой: токены и затраты в истории обязаны
    // совпадать с фактическим ответом, а не быть нулями.
    setModelClient({
      complete: async () => ({
        text: ARTICLE_TEXT,
        amounts: [],
        citations: [ARTICLE_TEXT],
        tokensIn: 321,
        tokensOut: 123,
        costRub: 1.25,
        model: "sandbox-model-08",
      }),
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it("история хранит версию, снимок конфигурации, результат, токены и затраты", async () => {
    await runSandbox({ tenantId, actor: "manager-08", text: "Как получить лицензию?" });
    await runSandbox({ tenantId, actor: "manager-08", text: "А когда пришлёте КП?" });

    const sessions = await listTestSessions(tenantId, 10);

    expect(sessions.length).toBe(2);
    for (const session of sessions) {
      expect(session.settingsVersion).toBeGreaterThanOrEqual(1);
      expect(session.settingsSnapshot.provider).toBeTruthy();
      expect(session.settingsSnapshot.model).toBeTruthy();
      expect(session.result.outcome).toBeTruthy();
      expect(session.result.grade).toBeTruthy();
      expect(session.tokensIn).toBe(321);
      expect(session.tokensOut).toBe(123);
      expect(session.costRub).toBe(1.25);
    }
  });

  it("в снимке конфигурации нет секретов", async () => {
    await updateSetting(tenantId, "model", "history-model-08", "manager-08");
    await runSandbox({ tenantId, actor: "manager-08", text: "Как получить лицензию?" });

    const sessions = await listTestSessions(tenantId, 10);
    const snapshot = sessions[0]?.settingsSnapshot;

    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain("history-secret-key-08");
    for (const key of Object.keys(snapshot ?? {})) {
      expect(key).not.toMatch(/api[_-]?key|secret|password|authorization/i);
    }
  });

  it("история отсортирована по времени убывания и ограничена арендатором", async () => {
    await runSandbox({ tenantId, actor: "manager-08", text: "Первый вопрос?" });
    await runSandbox({ tenantId, actor: "manager-08", text: "Второй вопрос?" });

    const sessions = await listTestSessions(tenantId, 10);
    const times = sessions.map((session) => session.createdAt);
    const sorted = [...times].sort((left, right) => right - left);
    expect(times).toEqual(sorted);

    const limited = await listTestSessions(tenantId, 1);
    expect(limited.length).toBe(1);

    const otherTenant = await ensureSliceDatabase(`${TENANT_SLUG}-other`);
    const otherSessions = await listTestSessions(otherTenant, 10);
    expect(otherSessions.length).toBe(0);
  });

  it("аудит содержит субъекта, настройку, время и безопасные значения до и после", async () => {
    const before = await readCurrentSettings(tenantId);
    await updateSetting(tenantId, "model", "audit-model-08", "manager-08");

    const entries = await listAuditEntries(tenantId, 10);
    const entry = entries[0];

    expect(entry?.actor).toBe("manager-08");
    expect(entry?.action).toBe("update");
    expect(entry?.entity).toBe("agent_settings");
    expect(entry?.key).toBe("model");
    expect(entry?.before).toEqual({ model: before.model });
    expect(entry?.after).toEqual({ model: "audit-model-08" });
    expect(entry?.createdAt).toBeGreaterThan(0);
  });

  it("секретное значение в before/after заменено маской", async () => {
    await testPool().query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity, before, after)
       VALUES ($1, 'manager-08', 'update', 'agent_settings',
               '{"api_key":"super-secret-value"}'::jsonb,
               '{"token":"another-secret"}'::jsonb)`,
      [tenantId],
    );

    const entries = await listAuditEntries(tenantId, 10);
    const dump = JSON.stringify(entries);

    expect(dump).not.toContain("super-secret-value");
    expect(dump).not.toContain("another-secret");
    expect(dump).toContain("[REDACTED]");
  });

  it("redactSecrets маскирует поля по имени и значение секрета из окружения", () => {
    process.env.OPENCODE_API_KEY = "history-secret-key-08";
    const redacted = redactSecrets({
      api_key: "visible-key",
      nested: { password: "visible-password" },
      model: "history-secret-key-08",
      keep: "visible-value",
    });

    const dump = JSON.stringify(redacted);
    expect(dump).not.toContain("visible-key");
    expect(dump).not.toContain("visible-password");
    expect(dump).not.toContain("history-secret-key-08");
    expect(dump).toContain("visible-value");
  });

  it("секреты не встречаются в audit_log, agent_test_sessions и ответе песочницы", async () => {
    await runSandbox({ tenantId, actor: "manager-08", text: "Как получить лицензию?" });

    const audit = await testPool().query<{ dump: string }>(
      `SELECT to_jsonb(x)::text AS dump FROM audit_log x WHERE x.tenant_id = $1`,
      [tenantId],
    );
    const sessions = await testPool().query<{ dump: string }>(
      `SELECT to_jsonb(x)::text AS dump FROM agent_test_sessions x WHERE x.tenant_id = $1`,
      [tenantId],
    );
    const steps = await testPool().query<{ dump: string }>(
      `SELECT to_jsonb(x)::text AS dump FROM agent_steps x WHERE x.tenant_id = $1`,
      [tenantId],
    );

    for (const rows of [audit, sessions, steps]) {
      expect(rows.rows.map((row) => row.dump).join(" ")).not.toContain(
        "history-secret-key-08",
      );
    }
  });

  it("аудит не содержит значений из text_original и меток ПД", async () => {
    await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Иван из ООО «Ромашка» ждёт лицензию",
    });

    const entries = await listAuditEntries(tenantId, 10);
    const dump = JSON.stringify(entries);

    expect(dump).not.toContain("Иван");
    expect(dump).not.toContain("Ромашка");
  });
});
