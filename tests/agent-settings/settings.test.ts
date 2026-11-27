import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { applyMigrationsToSchema, testPool } from "../db/helpers";
import {
  bindDialogVersion,
  createModelClientForSettings,
  listVersions,
  readCurrentSettings,
  updateSetting,
} from "@/modules/agent-settings";
import { createConversation, ensureSliceDatabase } from "./helpers";

/**
 * Настройки агента: хранение версий, аудит изменения и привязка версии
 * к диалогу.
 *
 * Команда проверки: `npm run test -- tests/agent-settings/settings.test.ts`
 */

const TENANT_SLUG = "test-agent-settings-08";
const MIGRATION_FILE = resolve(
  process.cwd(),
  "db/migrations/6000_agent_settings.sql",
);

type FetchCall = {
  url: string;
  /**
   * Тело запроса к модели.
   *
   * Имя поля лимита токенов у провайдера менялось (`max_tokens` → `maxTokens`),
   * поэтому тест смотрит значение, а не имя поля: проверяется, что до
   * провайдера дошло сохранённое число токенов.
   */
  body: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    maxTokens?: number;
  };
  headers: Record<string, string>;
};

/** Лимит токенов в теле запроса: имя поля у провайдера менялось. */
function maxTokensOf(body: FetchCall["body"]): number | undefined {
  return body.max_tokens ?? body.maxTokens;
}

function stubFetch(calls: FetchCall[]): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"],
      headers,
    });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ text: "Ответ модели", amounts: [], citations: [] }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, opencode: { list_cost: 0.5 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

/** Разбор миграции на части `-- Up Migration` и `-- Down Migration`. */
function splitMigration(content: string): { up: string; down: string } {
  const upMarker = /^\s*--\s*up\s+migration/im;
  const downMarker = /^\s*--\s*down\s+migration/im;
  const upStart = content.search(upMarker);
  const downStart = content.search(downMarker);
  const up = content.slice(upStart, downStart >= 0 ? downStart : undefined);
  const down = downStart >= 0 ? content.slice(downStart) : "";
  const strip = (sql: string) =>
    sql.replace(/^\s*--\s*(up|down)\s*migration\s*/im, "").trim();
  return { up: strip(up), down: strip(down) };
}

describe("настройки агента", () => {
  let tenantId = "";

  beforeAll(async () => {
    await ensureSliceDatabase(TENANT_SLUG);
  });

  beforeEach(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
    process.env.OPENCODE_API_KEY = "test-provider-key-08";
    process.env.LLM_MODEL = "default-model-08";
  });

  afterAll(async () => {
    await closePool();
  });

  it("миграция создаёт три таблицы среза с ожидаемыми колонками", async () => {
    const client = await testPool().connect();
    try {
      await applyMigrationsToSchema(client, "slice08_settings_check");
    } finally {
      client.release();
    }

    const columns = await testPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'slice08_settings_check'
         AND table_name IN ('agent_settings', 'agent_dialog_settings', 'agent_test_sessions')`,
    );
    const byTable = new Map<string, Set<string>>();
    for (const row of columns.rows) {
      const set = byTable.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      byTable.set(row.table_name, set);
    }

    expect(byTable.get("agent_settings")).toEqual(
      new Set([
        "id",
        "tenant_id",
        "version",
        "provider",
        "model",
        "endpoint",
        "system_prompt",
        "temperature",
        "max_tokens",
        "created_by",
        "created_at",
      ]),
    );
    expect(byTable.get("agent_dialog_settings")).toEqual(
      new Set(["conversation_id", "tenant_id", "version", "created_at"]),
    );
    expect(byTable.get("agent_test_sessions")).toEqual(
      new Set([
        "id",
        "tenant_id",
        "settings_version",
        "settings_snapshot",
        "request_text_masked",
        "result",
        "tokens_in",
        "tokens_out",
        "cost_rub",
        "actor",
        "created_at",
      ]),
    );

    await testPool().query("DROP SCHEMA IF EXISTS slice08_settings_check CASCADE");
  });

  it("откат миграции убирает три таблицы и не трогает audit_log и tenants", async () => {
    const migration = splitMigration(await readFile(MIGRATION_FILE, "utf8"));
    expect(migration.down).toContain("DROP TABLE agent_test_sessions");
    expect(migration.down).toContain("DROP TABLE agent_dialog_settings");
    expect(migration.down).toContain("DROP TABLE agent_settings");

    const client = await testPool().connect();
    try {
      await applyMigrationsToSchema(client, "slice08_rollback_check");
      await client.query("SET search_path TO slice08_rollback_check, public");
      await client.query(migration.down);

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'slice08_rollback_check'`,
      );
      const names = tables.rows.map((row) => row.table_name);
      expect(names).not.toContain("agent_settings");
      expect(names).not.toContain("agent_dialog_settings");
      expect(names).not.toContain("agent_test_sessions");
      expect(names).toContain("audit_log");
      expect(names).toContain("tenants");

      // Повторное применение проходит: миграция обратима.
      await client.query(migration.up);
      const restored = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'slice08_rollback_check'
           AND table_name IN ('agent_settings', 'agent_dialog_settings', 'agent_test_sessions')`,
      );
      expect(restored.rows.map((row) => row.table_name).sort()).toEqual([
        "agent_dialog_settings",
        "agent_settings",
        "agent_test_sessions",
      ]);
    } finally {
      client.release();
      await testPool().query("DROP SCHEMA IF EXISTS slice08_rollback_check CASCADE");
    }
  });

  it("существует уникальный индекс (tenant_id, version) в agent_settings", async () => {
    const index = await testPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'agent_settings' AND indexdef LIKE '%UNIQUE%'`,
    );
    expect(
      index.rows.some((row) => row.indexdef.includes("tenant_id, version")),
    ).toBe(true);
  });

  it("первое чтение создаёт стартовую конфигурацию из окружения", async () => {
    const settings = await readCurrentSettings(tenantId);

    expect(settings.version).toBe(1);
    expect(settings.model).toBe("default-model-08");
    expect(settings.systemPrompt.length).toBeGreaterThan(0);
    expect(settings.maxTokens).toBeGreaterThan(0);
  });

  it("изменение настройки создаёт новую версию и сохраняет предыдущую", async () => {
    const before = await readCurrentSettings(tenantId);

    const after = await updateSetting(tenantId, "model", "saved-model-08", "manager-08");

    expect(after.version).toBe(before.version + 1);
    expect(after.model).toBe("saved-model-08");

    const versions = await listVersions(tenantId);
    expect(versions.map((version) => version.version)).toEqual([
      before.version,
      after.version,
    ]);
    expect(versions[0]?.model).toBe(before.model);
    expect(versions[1]?.model).toBe("saved-model-08");
  });

  it("изменение пишет запись аудита с субъектом, настройкой и значениями до и после", async () => {
    const before = await readCurrentSettings(tenantId);
    await updateSetting(tenantId, "model", "audited-model-08", "manager-08");

    const audit = await testPool().query<{
      actor: string;
      action: string;
      entity: string;
      before: unknown;
      after: unknown;
      created_at: Date;
    }>(
      `SELECT actor, action, entity, before, after, created_at
       FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    );
    const entry = audit.rows[0];

    expect(entry?.actor).toBe("manager-08");
    expect(entry?.action).toBe("update");
    expect(entry?.entity).toBe("agent_settings");
    expect(entry?.before).toEqual({ model: before.model });
    expect(entry?.after).toEqual({ model: "audited-model-08" });
    expect(entry?.created_at).toBeInstanceOf(Date);
  });

  it("две версии одного арендатора не конфликтуют по индексу (tenant_id, version)", async () => {
    await updateSetting(tenantId, "temperature", 0.5, "manager-08");
    await updateSetting(tenantId, "temperature", 0.7, "manager-08");

    const rows = await testPool().query<{ version: number }>(
      "SELECT version FROM agent_settings WHERE tenant_id = $1 ORDER BY version",
      [tenantId],
    );
    expect(rows.rows.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it("секретное поле отклоняется, а не сохраняется", async () => {
    await expect(
      updateSetting(tenantId, "api_key", "secret-value-08", "manager-08"),
    ).rejects.toThrow(/секрет/i);

    const stored = await testPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_settings
       WHERE tenant_id = $1 AND (
         endpoint LIKE '%secret-value-08%' OR model LIKE '%secret-value-08%'
         OR system_prompt LIKE '%secret-value-08%')`,
      [tenantId],
    );
    expect(Number(stored.rows[0]?.count ?? "0")).toBe(0);
  });

  it("ключ shadow_mode не принимается модулем настроек", async () => {
    await expect(
      updateSetting(tenantId, "shadow_mode", true, "manager-08"),
    ).rejects.toThrow(/shadow_mode|тенев/i);
  });

  it("неподдерживаемая настройка отклоняется с пометкой «не реализовано»", async () => {
    await expect(
      updateSetting(tenantId, "mcp", "streamable-http", "manager-08"),
    ).rejects.toThrow(/не реализовано/i);
  });

  it("диалог, открытый до изменения, остаётся на прежней версии, а новый получает текущую", async () => {
    const oldConversation = await createConversation(tenantId, randomUUID());
    const oldVersion = await bindDialogVersion(tenantId, oldConversation);
    expect(oldVersion).toBe(1);

    await updateSetting(tenantId, "model", "second-model-08", "manager-08");

    const newConversation = await createConversation(tenantId, randomUUID());
    const newVersion = await bindDialogVersion(tenantId, newConversation);
    expect(newVersion).toBe(2);

    // Прежний диалог не переключается на новую версию.
    expect(await bindDialogVersion(tenantId, oldConversation)).toBe(1);

    const versions = await listVersions(tenantId);
    const oldSettings = versions.find((version) => version.version === oldVersion);
    const newSettings = versions.find((version) => version.version === newVersion);
    expect(oldSettings?.model).not.toBe("second-model-08");
    expect(newSettings?.model).toBe("second-model-08");
  });

  it("клиент модели по сохранённой конфигурации обращается к сохранённому адресу с сохранёнными параметрами", async () => {
    const calls: FetchCall[] = [];
    const client = createModelClientForSettings(
      {
        provider: "opencode-go",
        model: "saved-model-08",
        endpoint: "https://saved-endpoint.example/v1",
        temperature: 0.7,
        maxTokens: 555,
        systemPrompt: "",
      },
      { fetchImpl: stubFetch(calls) },
    );

    await client.complete({ messages: [{ role: "user", content: "вопрос" }] });

    const call = calls[0];
    expect(call?.url).toBe("https://saved-endpoint.example/v1/chat/completions");
    expect(call?.body.model).toBe("saved-model-08");
    expect(call?.body.temperature).toBe(0.7);
    expect(maxTokensOf(call?.body ?? {})).toBe(555);
  });

  it("ключ провайдера берётся из окружения и не попадает в базу и аудит", async () => {
    const calls: FetchCall[] = [];
    const client = createModelClientForSettings(
      {
        provider: "opencode-go",
        model: "saved-model-08",
        endpoint: "https://saved-endpoint.example/v1",
        temperature: 0.2,
        maxTokens: 1024,
        systemPrompt: "",
      },
      { fetchImpl: stubFetch(calls) },
    );
    await client.complete({ messages: [{ role: "user", content: "вопрос" }] });

    expect(calls[0]?.headers.authorization).toContain("test-provider-key-08");

    const dump = await testPool().query<{ dump: string }>(
      `SELECT to_jsonb(s)::text AS dump
       FROM agent_settings s WHERE s.tenant_id = $1`,
      [tenantId],
    );
    const audit = await testPool().query<{ dump: string }>(
      `SELECT to_jsonb(a)::text AS dump
       FROM audit_log a WHERE a.tenant_id = $1`,
      [tenantId],
    );
    expect(dump.rows.map((row) => row.dump).join(" ")).not.toContain("test-provider-key-08");
    expect(audit.rows.map((row) => row.dump).join(" ")).not.toContain("test-provider-key-08");
  });

  it("сохранённые настройки определяют запрос к модели: адрес, модель и параметры", async () => {
    const calls: FetchCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(calls);

    try {
      await updateSetting(
        tenantId,
        "endpoint",
        "https://saved-endpoint.example/v1",
        "manager-08",
      );
      await updateSetting(tenantId, "model", "saved-model-08", "manager-08");
      await updateSetting(tenantId, "temperature", 0.7, "manager-08");
      await updateSetting(tenantId, "max_tokens", 555, "manager-08");

      const conversationId = randomUUID();
      await createConversation(tenantId, conversationId);

      const settings = await readCurrentSettings(tenantId);
      const client = createModelClientForSettings(
        {
          provider: settings.provider,
          model: settings.model,
          endpoint: settings.endpoint,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          systemPrompt: settings.systemPrompt,
        },
        { fetchImpl: stubFetch(calls) },
      );
      await client.complete({
        sessionId: conversationId,
        messages: [
          { role: "system", content: settings.systemPrompt },
          { role: "user", content: "вопрос" },
        ],
      });

      const call = calls[0];
      expect(call?.url).toBe("https://saved-endpoint.example/v1/chat/completions");
      expect(call?.body.model).toBe("saved-model-08");
      expect(call?.body.temperature).toBe(0.7);
      expect(maxTokensOf(call?.body ?? {})).toBe(555);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
