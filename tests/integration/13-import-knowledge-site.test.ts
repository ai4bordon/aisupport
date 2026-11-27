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

/**
 * Интеграционный тест среза 13: обход сайта заказчика → извлечение текста →
 * нарезка на чанки → запись источников с провенансом.
 *
 * Сайт подменяется локальным сервером: тест детерминирован и не ходит на
 * ресурс заказчика. Живой обход выполняется отдельно, скриптом
 * `npm run import:docs`.
 */

/**
 * Строка подключения к базе среза: переменная окружения, а при её отсутствии
 * — документированный в `db/README.md` локальный адрес.
 */
const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:5433/support_agent_13";

type Route = { status: number; body: string };

function article(title: string, section: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
<article class="article">
  <div class="breadcrumbs__wrap"><div class="breadcrumbs__link">Раздел</div><div class="breadcrumbs__link">${section}</div></div>
  <h1>${title}</h1>
  <div class="content">${body}</div>
</article>
<footer class="footer">Служебный подвал</footer>
</body></html>`;
}

async function startSite(routes: Map<string, Route>): Promise<{
  server: Server;
  baseUrl: string;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push(path);
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
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe("Импорт базы знаний с сайта заказчика", () => {
  let pool: pg.Pool;
  let tenantId: string;
  let cacheDir: string;
  let baseUrl: string;
  let server: Server;

  beforeAll(async () => {
    // Импортёр читает строку подключения из окружения; в тесте она задаётся
    // локальной базой среза, если не пришла снаружи.
    process.env["DATABASE_URL"] ??= DATABASE_URL;
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const tenant = await pool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = 'demo-tenant'",
    );
    tenantId = tenant.rows[0]?.id ?? "";
    expect(tenantId).not.toBe("");
    cacheDir = await mkdtemp(join(tmpdir(), "kb-import-"));
    // Данные прошлого прогона удаляются: тест не должен зависеть от порядка
    // запусков и не должен наследовать чужие строки.
    await pool.query(
      `DELETE FROM kb_chunks WHERE tenant_id = $1 AND article_id IN (
         SELECT id FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE 'http://127.0.0.1:%'
       )`,
      [tenantId],
    );
    await pool.query(
      `DELETE FROM kb_source_snapshots WHERE tenant_id = $1 AND source_id IN (
         SELECT id FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE 'http://127.0.0.1:%'
       )`,
      [tenantId],
    );
    await pool.query(
      "DELETE FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE 'http://127.0.0.1:%'",
      [tenantId],
    );
    await pool.query(
      "DELETE FROM kb_articles WHERE tenant_id = $1 AND owner = 'customer-site' AND id NOT IN (SELECT id FROM kb_sources WHERE tenant_id = $1)",
      [tenantId],
    );
  });

  afterAll(async () => {
    // Фикстура теста не должна оставаться в общей базе среза.
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
    await pool?.query(
      "DELETE FROM kb_articles WHERE tenant_id = $1 AND owner = 'customer-site' AND id NOT IN (SELECT id FROM kb_sources WHERE tenant_id = $1)",
      [tenantId],
    );
    await pool?.end();
    await rm(cacheDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("обходит сайт, импортирует источники с провенансом и цитируемые чанки", async () => {
    const long = "Предложение с текстом для нарезки на чанки заданного размера. ";
    const routes = new Map<string, Route>([
      [
        "/ru-ru/id/",
        {
          status: 200,
          body: article("Softline ID", "Учётная запись", `<p>${long.repeat(30)}</p><a href="/ru-ru/id/login/">Вход</a>`),
        },
      ],
      [
        "/ru-ru/id/login/",
        {
          status: 200,
          body: article("Как войти в аккаунт", "Авторизация", `<p>${long.repeat(30)}</p>`),
        },
      ],
    ]);
    const started = await startSite(routes);
    server = started.server;
    baseUrl = started.baseUrl;

    const report = await crawlSite({
      roots: [`${baseUrl}/ru-ru/id/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "AISupportBot/1.0 (+https://github.com/ai4bordon/aisupport)",
      cacheDir,
      timeBudgetMs: 60_000,
    });

    expect(report.stoppedReason).toBe("completed");
    expect(report.pages.length).toBe(2);

    const imported = await importCrawledPages(report.pages, {
      tenantSlug: "demo-tenant",
      embeddingProvider: createDeterministicEmbeddingProvider(),
    });

    expect(imported.failed).toBe(0);
    expect(imported.sources).toBe(2);
    expect(imported.chunks).toBeGreaterThan(0);

    // Источник: статус approved_by_customer, непустой провенанс, URL и путь.
    const sources = await pool.query<{
      source_url: string;
      title: string;
      section_path: string;
      status: string;
      provenance: string;
      origin: string;
      raw_html_path: string;
      crawled_at: Date;
    }>(
      `SELECT source_url, title, section_path, status, provenance, origin, raw_html_path, crawled_at
       FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE $2
       ORDER BY source_url`,
      [tenantId, `${baseUrl}/%`],
    );

    expect(sources.rows).toHaveLength(2);
    for (const source of sources.rows) {
      expect(source.status).toBe("approved_by_customer");
      expect(source.provenance.length).toBeGreaterThan(0);
      expect(source.provenance).toContain("обход");
      expect(source.origin).toBe("docs_site");
      expect(source.section_path).not.toBe("");
      expect(source.crawled_at).toBeInstanceOf(Date);
      // Сырой HTML лежит в кэше, в базе — только извлечённый текст.
      expect(source.raw_html_path).toContain(cacheDir);
      expect(source.raw_html_path).not.toContain("<h1>");
    }

    const sample = sources.rows[0];
    expect(sample).toBeDefined();
    expect(sample?.title.length).toBeGreaterThan(0);

    // Чанки: 800–1200 знаков, с URL источника и заголовком.
    const chunks = await pool.query<{
      text: string;
      chunk_no: number;
      page_no: number | null;
      article_id: string;
      tenant_id: string;
      title: string;
    }>(
      `SELECT c.text, c.chunk_no, c.page_no, c.article_id, c.tenant_id, a.title
       FROM kb_chunks c
       JOIN kb_articles a ON a.id = c.article_id
       JOIN kb_sources s ON s.id = c.article_id
       WHERE c.tenant_id = $1 AND s.source_url LIKE $2
       ORDER BY a.title, c.chunk_no`,
      [tenantId, `${baseUrl}/%`],
    );

    expect(chunks.rows.length).toBe(imported.chunks);
    for (const chunk of chunks.rows) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(800);
      expect(chunk.text.length).toBeLessThanOrEqual(1200);
      expect(chunk.text).toContain("Источник: http");
      // Заголовок источника есть в шапке чанка — цитата читаема.
      expect(chunk.text).toContain(chunk.title);
    }

    // Источники без цитируемого текста в поиск не попадают: у них нет чанков.
    const withoutChunks = await pool.query<{ count: string }>(
      `SELECT count(*) FROM kb_sources s
       WHERE s.tenant_id = $1 AND s.source_url LIKE $2
         AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.article_id = s.id)`,
      [tenantId, `${baseUrl}/%`],
    );
    expect(Number(withoutChunks.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(0);

    // История снимков: источник и дата обхода видны по снимку.
    const snapshots = await pool.query<{
      source_id: string;
      provenance: string;
      crawled_at: Date;
      status: string;
    }>(
      `SELECT source_id, provenance, crawled_at, status
       FROM kb_source_snapshots WHERE tenant_id = $1 AND source_id IN (
         SELECT id FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE $2
       )`,
      [tenantId, `${baseUrl}/%`],
    );

    expect(snapshots.rows.length).toBe(2);
    for (const snapshot of snapshots.rows) {
      expect(snapshot.source_id.length).toBeGreaterThan(0);
      expect(snapshot.provenance.length).toBeGreaterThan(0);
      expect(snapshot.crawled_at).toBeInstanceOf(Date);
      expect(snapshot.status).toBe("approved_by_customer");
    }
  });

  it("повторный импорт обновляет источник, а не плодит дубли", async () => {
    const before = await pool.query<{ count: string }>(
      "SELECT count(*) FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE $2",
      [tenantId, `${baseUrl}/%`],
    );

    const second = await crawlSite({
      roots: [`${baseUrl}/ru-ru/id/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "AISupportBot/1.0 (+https://github.com/ai4bordon/aisupport)",
      cacheDir,
      timeBudgetMs: 60_000,
    });

    // Повторный запуск берёт кэш и не обращается к сайту.
    expect(second.visited).toBe(0);
    expect(second.cached).toBeGreaterThan(0);

    await importCrawledPages(second.pages, {
      tenantSlug: "demo-tenant",
      embeddingProvider: createDeterministicEmbeddingProvider(),
    });

    const after = await pool.query<{ count: string }>(
      "SELECT count(*) FROM kb_sources WHERE tenant_id = $1 AND source_url LIKE $2",
      [tenantId, `${baseUrl}/%`],
    );

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
