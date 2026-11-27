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

/**
 * Ответ модели по умолчанию: текст статьи базы знаний.
 *
 * Ответ зависит от того, о чём спросили: на запрос классификатора модель
 * возвращает код класса обращения, а на генерацию ответа — текст статьи.
 * Иначе песочница всегда считала бы запрос базой знаний и никогда не
 * доходила до каталога.
 */
function stubFetch(calls: FetchCall[], intent = "product_unknown"): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = String(init?.body ?? "");
    calls.push({ url: String(input), body });
    // Запрос классификатора узнаётся по его промпту.
    const isClassifier = body.includes("Определи класс обращения клиента");
    // Цитата ответа должна быть из подтверждённого источника: на вопрос о
    // продуктах источником будет карточка каталога, и цитата берётся из неё.
    const citation = body.includes("Dr.Web Security Suite")
      ? "Dr.Web Security Suite"
      : ARTICLE_TEXT;
    const content = isClassifier
      ? intent
      : JSON.stringify({
          text: citation,
          amounts: [],
          citations: [citation],
        });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
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

/**
 * Позиции каталога для проверки обращения песочницы к каталогу.
 *
 * Каталог заполняется напрямую: тест проверяет маршрут песочницы, а не
 * разбор фида.
 */
async function seedCatalogProducts(): Promise<void> {
  const pool = testPool();

  await pool.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]);

  const fixtures = [
    {
      offerId: "sb-9001",
      name: "Dr.Web Security Suite, 50 ПК",
      vendor: "Доктор Веб",
      price: 80818.4,
      quantity: 50,
      categoryId: "sb-cat-av",
    },
    {
      offerId: "sb-9002",
      name: "Dr.Web Security Suite, 100 ПК",
      vendor: "Доктор Веб",
      price: 129000,
      quantity: 100,
      categoryId: "sb-cat-av",
    },
  ];

  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO catalog_snapshots (tenant_id, source_url, feed_date, fetched_at, snapshot_hash, offers_count, categories_count, is_current, source_kind)
     VALUES ($1, 'https://store.softline.ru/feeds/Softline.yml.gz', now(), now(), $2, $3, 0, true, 'test')
     RETURNING id`,
    [tenantId, `hash-sb-${Date.now()}`, fixtures.length],
  );
  const snapshotId = snapshot.rows[0]?.id ?? "";

  await pool.query(
    `INSERT INTO catalog_categories (tenant_id, category_id, name, path)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, category_id) DO UPDATE SET path = EXCLUDED.path`,
    [
      tenantId,
      "sb-cat-av",
      "Антивирусы для организаций",
      "Антивирусы и безопасность / Антивирусы для организаций",
    ],
  );

  for (const fixture of fixtures) {
    await pool.query(
      `INSERT INTO products (tenant_id, offer_id, name, vendor, product_url, price, currency_id, available, delivery, params, snapshot_id, status, published, category_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'RUR', true, true, $7::jsonb, $8, 'approved_by_customer', true, $9)`,
      [
        tenantId,
        fixture.offerId,
        fixture.name,
        fixture.vendor,
        `https://store.softline.ru/test/${fixture.offerId}/`,
        fixture.price,
        JSON.stringify({
          "К-во пользователей": `от ${fixture.quantity} до ${fixture.quantity}`,
          "Срок действия": "12 мес.",
          "Способ доставки": "Клиентская",
        }),
        snapshotId,
        fixture.categoryId,
      ],
    );
  }
}

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
      // Канал MAX не вызывается, и маршрут веб-чата стенда
      // (`/v1/chat` самого приложения) не вызывается. Адрес модели провайдера
      // содержит `/v1/chat/completions` — это не маршрут стенда.
      expect(call.url).not.toContain("platform-api.max.ru");
      expect(call.url).not.toContain("localhost/v1/chat");
      expect(call.url).not.toContain("127.0.0.1/v1/chat");
      const { pathname } = new URL(call.url);
      expect(pathname).not.toBe("/v1/chat");
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

  it("песочница обращается к каталогу: вопрос о продуктах находит позиции", async () => {
    // Дефект: песочница искала только по базе знаний и отвечала «в
    // источниках нет информации», хотя обычный чат на тот же вопрос
    // подбирал позиции из каталога.
    await seedCatalogProducts();

    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls);

    const result = await runSandbox({
      tenantId,
      actor: "manager-08",
      text: "Какие у тебя есть продукты из раздела антивирусы?",
    });

    // Каталог вызван: в трассе есть узел поиска по каталогу.
    expect(result.trace.map((step) => step.node)).toContain("catalog");
    // Позиции каталога попали в источники ответа.
    expect(result.sources.some((source) => source.kind === "catalog_product")).toBe(true);
    // Итог не «нет источников»: ответ построен по найденным позициям.
    expect(result.outcome).toBe("respond");
    expect(result.grade).not.toBe("no_confirmed_source");
  });
});
