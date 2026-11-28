import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import pg from "pg";

import {
  crawlSite,
  importCrawledPages,
  createDeterministicEmbeddingProvider,
} from "@/import/knowledge";
import { search, setEmbeddingProvider } from "@/modules/knowledge";
import { scopeEnv } from "../env-scope/helpers";

/**
 * Короткий материал должен попадать в индекс.
 *
 * Регрессия (UX-аудит 28.11, живой стенд): статья «Оплата подписки»
 * объёмом 161 знак была опубликована, но при импорте её единственный чанк
 * отбрасывался по правилу «чанк короче 800 знаков». Статья оставалась
 * опубликованной, но в поиске не находилась, и вопрос «Как оплатить
 * подписку?» уходил в эскалацию: источника не было, а ответ по другим
 * статьям отклонялся валидатором.
 *
 * Проверяется полный путь: импорт короткой статьи → чанк в базе → поиск
 * находит статью → опубликованный материал виден клиенту.
 */

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:5433/support_agent_13";

/**
 * Арендатор теста.
 *
 * Свой арендатор: поиск возвращает топ по вектору, и на общей базе
 * статья теста конкурировала бы со статьями демо-стенда — проверка
 * нашла бы чужую статью, а не ту, что импортирована.
 */
const TENANT_SLUG = "test-short-article-index";

type Route = { status: number; body: string };

/**
 * Текст статьи «Оплата подписки» со стенда: 161 знак.
 *
 * Ровно такой объём был у статьи на стенде, из-за которого вопрос не
 * находил источника.
 */
const PAYMENT_BODY =
  "Как оплатить подписку: оплата производится автоматически по данным " +
  "платёжного метода. Подписка с автоматическим продлением (AR) требует " +
  "согласия покупателя, отмена доступна в личном кабинете.";

function article(title: string, section: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
<article class="article">
  <div class="breadcrumbs__wrap"><div class="breadcrumbs__link">Раздел</div><div class="breadcrumbs__link">${section}</div></div>
  <h1>${title}</h1>
  <div class="content">${body}</div>
</article>
</body></html>`;
}

async function startSite(routes: Map<string, Route>): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const route = routes.get(path);
    if (!route) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>404</body></html>");
      return;
    }
    res.writeHead(route.status, { "content-type": "text/html; charset=utf-8" });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("короткий опубликованный материал попадает в индекс", () => {
  let pool: pg.Pool;
  let tenantId: string;
  let cacheDir: string;
  let baseUrl: string;
  let server: Server;

  beforeAll(async () => {
    scopeEnv("DATABASE_URL", DATABASE_URL);
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const tenant = await pool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = $1",
      [TENANT_SLUG],
    );
    if (tenant.rows[0]?.id === undefined) {
      await pool.query("INSERT INTO tenants (slug, name) VALUES ($1, $2)", [
        TENANT_SLUG,
        "Арендатор теста короткой статьи",
      ]);
    }
    const created = await pool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = $1",
      [TENANT_SLUG],
    );
    tenantId = created.rows[0]?.id ?? "";
    expect(tenantId).not.toBe("");
    cacheDir = await mkdtemp(join(tmpdir(), "kb-short-import-"));
    // Поиск сверяет вектор по модели эмбеддингов: импорт и поиск должны
    // работать на одной модели, иначе найденные чанки не совпадут.
    setEmbeddingProvider(createDeterministicEmbeddingProvider());
  });

  afterAll(async () => {
    await pool?.query(
      `DELETE FROM kb_chunks WHERE tenant_id = $1 AND article_id IN (
         SELECT id FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE 'http://127.0.0.1:%'
       )`,
      [tenantId],
    );
    await pool?.query(
      `DELETE FROM kb_source_snapshots WHERE tenant_id = $1 AND source_id IN (
         SELECT id FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE 'http://127.0.0.1:%'
       )`,
      [tenantId],
    );
    await pool?.query(
      "DELETE FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE 'http://127.0.0.1:%'",
      [tenantId],
    );
    await pool?.end();
    await rm(cacheDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("короткая статья получает чанок и находится поиском", async () => {
    const routes = new Map<string, Route>([
      [
        "/ru-ru/payments/subscription-payment/",
        {
          status: 200,
          body: article(
            "Оплата подписки",
            "Платежные методы",
            `<p>${PAYMENT_BODY}</p>`,
          ),
        },
      ],
    ]);

    const site = await startSite(routes);
    server = site.server;
    baseUrl = site.baseUrl;

    const crawl = await crawlSite({
      roots: [`${baseUrl}/ru-ru/payments/subscription-payment/`],
      maxDepth: 0,
      cacheDir,
      delayMs: 0,
      userAgent: "test-agent/1.0",
      timeBudgetMs: 15_000,
    });

    const imported = await importCrawledPages(crawl.pages, {
      tenantSlug: TENANT_SLUG,
      embeddingProvider: createDeterministicEmbeddingProvider(),
    });

    // Источник импортирован, и у него есть чанк: короткий материал не
    // отброшен.
    expect(imported.sources).toBe(1);
    expect(imported.chunks).toBeGreaterThan(0);

    const chunks = await pool.query<{ text: string; article_id: string }>(
      `SELECT c.text, c.article_id
         FROM kb_chunks c
         JOIN kb_sources s ON s.id = c.article_id
        WHERE c.tenant_id = $1 AND s.source_url LIKE $2`,
      [tenantId, `${baseUrl}/%`],
    );

    expect(chunks.rows.length).toBeGreaterThan(0);
    expect(chunks.rows[0]?.text).toContain("Как оплатить подписку");

    // Статья опубликована: только опубликованные материалы ищутся.
    const articleRow = await pool.query<{ status: string }>(
      "SELECT status FROM kb_articles WHERE id = $1",
      [chunks.rows[0]?.article_id ?? ""],
    );
    expect(articleRow.rows[0]?.status).toBe("published");

    // Поиск находит статью по вопросу про оплату подписки.
    const found = await search("Как оплатить подписку?", tenantId);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((match) => match.title === "Оплата подписки")).toBe(true);
  });
});
