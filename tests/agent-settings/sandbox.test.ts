import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { runSandbox } from "@/modules/agent-settings";
import { testPool } from "../db/helpers";
import { ensureSliceDatabase, workingCounters } from "./helpers";

/**
 * Песочница: тестовая сессия изолирована от рабочего окружения.
 *
 * Команда проверки: `npm run test -- tests/agent-settings/sandbox.test.ts`
 */

const TENANT_SLUG = "test-agent-sandbox-08";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

type FetchCall = { url: string; body: string };

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
        usage: { prompt_tokens: 30, completion_tokens: 40, opencode: { list_cost: 0.25 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function articleEmbedding(): number[] {
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
  return vector;
}

describe("песочница настроек агента", () => {
  let tenantId = "";
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
  });

  beforeEach(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
    originalFetch = globalThis.fetch;
    // Ключ провайдера — из окружения: песочница собирает клиента по
    // сохранённой конфигурации, и без ключа вызов не состоялся бы.
    process.env.OPENCODE_API_KEY = "sandbox-provider-key-08";

    const article = await testPool().query<{ id: string }>(
      `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
       VALUES ($1, 'Лицензирование', $2, 'published', now(), now())
       RETURNING id`,
      [tenantId, ARTICLE_TEXT],
    );
    await testPool().query(
      `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
       VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
      [tenantId, article.rows[0]?.id ?? "", ARTICLE_TEXT, `[${articleEmbedding().join(",")}]`],
    );
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await closePool();
  });

  it("тестовая сессия не меняет рабочие таблицы и счётчики", async () => {
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
  });

  it("песочница не обращается к MAX и не отправляет запрос в веб-чат", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);

    await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Как получить электронную лицензию?",
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain("platform-api.max.ru");
      expect(call.url).not.toContain("/v1/chat");
    }
  });

  it("песочница не создаёт обещаний и не возвращает клиентский текст", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);

    const result = await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Когда пришлёте КП?",
    });

    expect(result.answer).not.toContain("ОБЕЩАНИЕ:");

    const promises = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM promises WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(promises.rows[0]?.count ?? "0")).toBe(0);
  });

  it("тестовая сессия получает собственный идентификатор и собственную трассу", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);

    const result = await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Как получить электронную лицензию?",
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.trace.length).toBeGreaterThan(0);
    expect(result.trace.map((step) => step.node)).toContain("retrieve");
    expect(result.trace.map((step) => step.node)).toContain("respond");

    const steps = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_steps WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(steps.rows[0]?.count ?? "0")).toBe(0);
  });

  it("результат песочницы не попадает в диалог клиента", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);

    await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Как получить электронную лицензию?",
    });

    const messages = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(messages.rows[0]?.count ?? "0")).toBe(0);
  });
});
