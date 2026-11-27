import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import {
  bindDialogVersion,
  listAuditEntries,
  listTestSessions,
  readCurrentSettings,
  runSandbox,
  updateSetting,
} from "@/modules/agent-settings";
import { setModelClient, type ModelClient } from "@/core/model";
import { testPool } from "../db/helpers";
import { createConversation, ensureSliceDatabase, workingCounters } from "../agent-settings/helpers";

/**
 * Интеграционный тест среза 08: настройки агента, песочница, история и аудит.
 *
 * Команда проверки тикета:
 * `npm run test -- tests/integration/08-agent-settings-sandbox.test.ts`
 */

const TENANT_SLUG = "integration-08-agent-settings";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

type FetchCall = { url: string; body: string };

/** Модель с известной метрикой: токены и затраты в истории проверяемы. */
function knownMetricModel(): ModelClient {
  return {
    complete: async () => ({
      text: ARTICLE_TEXT,
      amounts: [],
      citations: [ARTICLE_TEXT],
      tokensIn: 210,
      tokensOut: 90,
      costRub: 0.75,
      model: "integration-model-08",
    }),
  };
}

/** Подставленный `fetch`: фиксирует адреса обращений песочницы. */
function stubFetch(calls: FetchCall[]): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                text: ARTICLE_TEXT,
                amounts: [],
                citations: [ARTICLE_TEXT],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 210, completion_tokens: 90, opencode: { list_cost: 0.75 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("08 — настройки агента, песочница, история и аудит", () => {
  let tenantId = "";
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
  });

  beforeEach(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
    originalFetch = globalThis.fetch;
    setModelClient(knownMetricModel());

    const article = await testPool().query<{ id: string }>(
      `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
       VALUES ($1, 'Лицензирование', $2, 'published', now(), now())
       RETURNING id`,
      [tenantId, ARTICLE_TEXT],
    );
    const vector = new Array<number>(1536).fill(0);
    for (const word of ["Электронная", "лицензия", "предоставляется"]) {
      const stem = word.toLowerCase().slice(0, 6);
      let hash = 2166136261;
      for (let index = 0; index < stem.length; index += 1) {
        hash ^= stem.charCodeAt(index);
        hash = Math.imul(hash, 16777777);
      }
      vector[Math.abs(hash) % 1536] = (vector[Math.abs(hash) % 1536] ?? 0) + 1;
    }
    await testPool().query(
      `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
       VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
      [
        tenantId,
        article.rows[0]?.id ?? "",
        ARTICLE_TEXT,
        `[${vector.join(",")}]`,
      ],
    );
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await closePool();
  });

  it("менеджер сохраняет настройку: появляется новая версия и запись аудита", async () => {
    const before = await readCurrentSettings(tenantId);

    const after = await updateSetting(
      tenantId,
      "model",
      "integration-model-08",
      "manager-08",
    );

    expect(after.version).toBe(before.version + 1);
    expect(after.model).toBe("integration-model-08");

    const audit = await listAuditEntries(tenantId, 10);
    expect(audit[0]?.actor).toBe("manager-08");
    expect(audit[0]?.action).toBe("update");
    expect(audit[0]?.entity).toBe("agent_settings");
    expect(audit[0]?.key).toBe("model");
    expect(audit[0]?.before).toEqual({ model: before.model });
    expect(audit[0]?.after).toEqual({ model: "integration-model-08" });
  });

  it("диалог, открытый до изменения, остаётся на прежней версии, а новый получает текущую", async () => {
    const oldConversation = await createConversation(tenantId, randomUUID());
    const oldVersion = await bindDialogVersion(tenantId, oldConversation);

    await updateSetting(tenantId, "model", "second-model-08", "manager-08");

    const newConversation = await createConversation(tenantId, randomUUID());
    const newVersion = await bindDialogVersion(tenantId, newConversation);

    expect(oldVersion).toBe(1);
    expect(newVersion).toBe(2);
    expect(await bindDialogVersion(tenantId, oldConversation)).toBe(oldVersion);
  });

  it("неподдерживаемый элемент управления не принимает изменения", async () => {
    await expect(
      updateSetting(tenantId, "mcp", "streamable-http", "manager-08"),
    ).rejects.toThrow(/не реализовано/i);
  });

  it("песочница не меняет рабочее окружение и не обращается к MAX", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);

    const before = await workingCounters(tenantId);
    const result = await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Как получить электронную лицензию?",
    });
    const after = await workingCounters(tenantId);

    expect(result.outcome).toBe("respond");
    expect(after).toEqual(before);
    for (const call of calls) {
      // Канал MAX не вызывается, и маршрут веб-чата стенда (`/v1/chat`
      // самого приложения) не вызывается. Адрес модели провайдера содержит
      // `/v1/chat/completions` — это не маршрут стенда.
      expect(call.url).not.toContain("platform-api.max.ru");
      const { pathname } = new URL(call.url);
      expect(pathname).not.toBe("/v1/chat");
    }
  });

  it("история хранит версию, снимок, результат, токены и затраты", async () => {
    await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Как получить электронную лицензию?",
    });

    const sessions = await listTestSessions(tenantId, 10);
    const session = sessions[0];

    expect(session?.settingsVersion).toBeGreaterThanOrEqual(1);
    expect(session?.settingsSnapshot["model"]).toBeTruthy();
    expect(session?.result.outcome).toBe("respond");
    expect(session?.result.grade).toBe("ok");
    expect(session?.tokensIn).toBe(210);
    expect(session?.tokensOut).toBe(90);
    expect(session?.costRub).toBe(0.75);
  });

  it("в аудите, истории и трассе нет секретов", async () => {
    process.env.OPENCODE_API_KEY = "integration-secret-key-08";

    await updateSetting(tenantId, "endpoint", "https://saved.example/v1", "manager-08");
    await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Как получить электронную лицензию?",
    });

    for (const table of ["audit_log", "agent_test_sessions", "agent_steps"]) {
      const rows = await testPool().query<{ dump: string }>(
        `SELECT to_jsonb(x)::text AS dump FROM ${table} x WHERE x.tenant_id = $1`,
        [tenantId],
      );
      expect(rows.rows.map((row) => row.dump).join(" ")).not.toContain(
        "integration-secret-key-08",
      );
    }
  });

  it("в маршрутах кабинета неподдерживаемый элемент помечен supported: false", async () => {
    const { GET } = await import("@/app/api/settings/route");
    const response = await GET(
      new Request("http://localhost/api/settings", {
        headers: { cookie: await managerCookie() },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      capabilities: Array<{ key: string; supported: boolean; reason: string | null }>;
    };
    const mcp = body.capabilities.find((item) => item.key === "mcp");
    expect(mcp?.supported).toBe(false);
    expect(mcp?.reason).toMatch(/не реализовано/i);
  });

  it("без cookie менеджера маршруты кабинета закрыты", async () => {
    const { GET: getSettings } = await import("@/app/api/settings/route");
    const { GET: getHistory } = await import("@/app/api/settings/history/route");
    const { GET: getAudit } = await import("@/app/audit/route");

    for (const handler of [getSettings, getHistory, getAudit]) {
      const response = await handler(
        new Request("http://localhost/api/settings", { headers: {} }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("следующий новый диалог ядра идёт по сохранённой конфигурации, а открытый ранее — по прежней", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);
    // Подменённый клиент снимается: вызов должен пойти по сохранённой
    // конфигурации, а не через тестовую заглушку.
    setModelClient(null);

    try {
      const oldConversation = await createConversation(tenantId, randomUUID());
      await bindDialogVersion(tenantId, oldConversation);

      await updateSetting(
        tenantId,
        "endpoint",
        "https://saved-endpoint.example/v1",
        "manager-08",
      );
      await updateSetting(tenantId, "model", "saved-model-08", "manager-08");
      await updateSetting(tenantId, "temperature", 0.7, "manager-08");
      await updateSetting(tenantId, "max_tokens", 555, "manager-08");

      const newConversation = await createConversation(tenantId, randomUUID());
      await bindDialogVersion(tenantId, newConversation);

      const { runAgent } = await import("@/core/run");
      await runAgent({
        conversationId: newConversation,
        messageId: randomUUID(),
        channel: "web",
        externalChatId: null,
        text: "Как получить электронную лицензию?",
        maskedFieldsCount: 0,
        tenantId,
      });

      // Вызов генерации ответа опознаётся по подсказке с источниками:
      // классификатор ходит с тем же адресом и моделью, но с собственным
      // лимитом токенов.
      const call = calls.find((item) =>
        item.body.includes("Подтверждённые источники"),
      );
      expect(call, "сохранённый адрес не использован").toBeDefined();
      expect(call?.url.startsWith("https://saved-endpoint.example/v1")).toBe(true);
      const body = JSON.parse(call?.body ?? "{}") as {
        model?: string;
        temperature?: number;
        max_tokens?: number;
        maxTokens?: number;
      };
      expect(body.model).toBe("saved-model-08");
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens ?? body.maxTokens).toBe(555);
    } finally {
      setModelClient(knownMetricModel());
    }
  });

  it("диалог, открытый до изменения, работает по прежней версии конфигурации", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);
    setModelClient(null);

    try {
      const oldConversation = await createConversation(tenantId, randomUUID());
      await bindDialogVersion(tenantId, oldConversation);

      await updateSetting(
        tenantId,
        "endpoint",
        "https://saved-endpoint.example/v1",
        "manager-08",
      );

      const { runAgent } = await import("@/core/run");
      await runAgent({
        conversationId: oldConversation,
        messageId: randomUUID(),
        channel: "web",
        externalChatId: null,
        text: "Как получить электронную лицензию?",
        maskedFieldsCount: 0,
        tenantId,
      });

      // Прежняя версия — свой адрес: новый адрес на диалог не действует.
      expect(
        calls.some((item) => item.url.startsWith("https://saved-endpoint.example/v1")),
      ).toBe(false);
    } finally {
      setModelClient(knownMetricModel());
    }
  });
});

/**
 * Cookie кабинета: подписанная сессия доступа.
 *
 * Код один на весь стенд: кабинет открывается той же cookie, что и чат
 * (решение владельца от 28.11.2026).
 */
async function managerCookie(): Promise<string> {
  const { signAccessSession, verifyAccessCode } = await import(
    "@/modules/access/session"
  );
  process.env.ACCESS_CODE = "integration-manager-08";
  process.env.SESSION_SECRET = "integration-secret-08";
  const session = await verifyAccessCode("integration-manager-08");
  if (!session) throw new Error("Сессия доступа не выдана");
  return `support_access=${signAccessSession(session)}`;
}
