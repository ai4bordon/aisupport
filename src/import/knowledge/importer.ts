/**
 * Запись импортированных источников в базу знаний с провенансом.
 *
 * Правила (контракт §8.3, спецификация R18/R22):
 * - источник с сайта заказчика получает `status=approved_by_customer` и
 *   непустой провенанс, ручного одобрения не требует;
 * - материал менеджера и черновики статей этот поток не задевают: их статусы
 *   (`pending`, `draft`) и пустой провенанс остаются как есть;
 * - в базу попадает только извлечённый текст, сырой HTML лежит в кэше;
 * - каждый чанк несёт заголовок, путь разделов и URL источника, поэтому
 *   найденный чанк цитируем.
 *
 * Чанк принадлежит либо документу, либо статье (ограничение `kb_chunks`).
 * Импортированная страница — не документ менеджера и не черновик статьи,
 * поэтому источник представлен опубликованной статьёй (`kb_articles`), а
 * источник с провенансом лежит в `kb_sources`.
 */

import { createHash } from "node:crypto";
import pg from "pg";

import { chunkSource, sourceId, type Chunk, type SourceContent } from "./chunk";
import { crawlSite, type CrawlOptions, type CrawledPage } from "./crawl";
import {
  createDeterministicEmbeddingProvider,
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding";

export type ImportReport = {
  sources: number;
  chunks: number;
  failed: number;
};

export type ImportOptions = {
  /** Слаг арендатора, для которого импортируется материал. */
  tenantSlug?: string;
  /** Провайдер эмбеддингов; по умолчанию — API, при отсутствии ключа — детерминированный. */
  embeddingProvider?: EmbeddingProvider;
  /** Дополнительные страницы: магазин заказчика импортируется отдельно. */
  extraPages?: CrawledPage[];
  /** Происхождение дополнительных страниц. */
  extraOrigin?: "docs_site" | "store_page";
  /** Провенанс дополнительных страниц. */
  extraProvenance?: string;
};

export type ImportDocsSiteOptions = CrawlOptions & ImportOptions;

const DEFAULT_TENANT_SLUG = "demo-tenant";
const DOCS_ORIGIN = "docs_site";
const STORE_ORIGIN = "store_page";

/** Провенанс импорта: домен и дата обхода. */
function provenanceFor(domain: string, crawledAt: string): string {
  const date = new Date(crawledAt);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${domain}, обход ${day}.${month}.${date.getUTCFullYear()}`;
}

function snapshotHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Номер страницы из пути разделов: число разделов, иначе null. */
function pageNoFrom(sectionPath: string): number | null {
  const segments = sectionPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments.length : null;
}

/** Пул подключений к базе: `DATABASE_URL` только из окружения. */
function createPool(): pg.Pool {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("Не задана переменная DATABASE_URL");
  }
  return new pg.Pool({ connectionString, max: 4 });
}

/**
 * Импортирует уже собранные страницы: пишет источники, статьи и чанки.
 *
 * @param pages собранные страницы.
 * @param options параметры импорта.
 */
export async function importCrawledPages(
  pages: CrawledPage[],
  options: ImportOptions = {},
): Promise<ImportReport> {
  if (pages.length === 0) return { sources: 0, chunks: 0, failed: 0 };

  const pool = createPool();
  const embeddingProvider =
    options.embeddingProvider ??
    (process.env["OPENCODE_API_KEY"]
      ? createEmbeddingProvider()
      : createDeterministicEmbeddingProvider());

  const client = await pool.connect();
  let sources = 0;
  let chunks = 0;
  let failed = 0;

  try {
    const tenant = await client.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = $1",
      [options.tenantSlug ?? DEFAULT_TENANT_SLUG],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) {
      throw new Error(`Арендатор ${options.tenantSlug ?? DEFAULT_TENANT_SLUG} не найден`);
    }

    for (const page of pages) {
      try {
        const written = await importPage(client, tenantId, page, embeddingProvider, options);
        sources += written.sources;
        chunks += written.chunks;
      } catch (error) {
        failed += 1;
        console.error(`Импорт не удался: ${page.url}: ${(error as Error).message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  return { sources, chunks, failed };
}

/** Запись одной страницы: источник, статья, чанки, снимок. */
async function importPage(
  client: pg.PoolClient,
  tenantId: string,
  page: CrawledPage,
  embeddingProvider: EmbeddingProvider,
  options: ImportOptions,
): Promise<{ sources: number; chunks: number }> {
  const origin = options.extraOrigin ?? (page.url.includes("store.softline.ru") ? STORE_ORIGIN : DOCS_ORIGIN);
  const domain = origin === STORE_ORIGIN ? "store.softline.ru" : "docs.softline.com";
  const provenance = options.extraProvenance ?? provenanceFor(domain, page.crawledAt);
  const hash = snapshotHash(page.text);
  const id = sourceId(page.url);

  const source = await client.query<{ id: string }>(
    `INSERT INTO kb_sources (
       id, tenant_id, origin, source_url, title, section_path, content_text,
       raw_html_path, crawled_at, snapshot_hash, status, provenance
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved_by_customer', $11)
     ON CONFLICT (tenant_id, source_url) DO UPDATE SET
       title = EXCLUDED.title,
       section_path = EXCLUDED.section_path,
       content_text = EXCLUDED.content_text,
       raw_html_path = EXCLUDED.raw_html_path,
       crawled_at = EXCLUDED.crawled_at,
       snapshot_hash = EXCLUDED.snapshot_hash,
       status = EXCLUDED.status,
       provenance = EXCLUDED.provenance
     RETURNING id`,
    [
      id,
      tenantId,
      origin,
      page.url,
      page.title,
      page.sectionPath,
      page.text,
      page.rawHtmlPath,
      page.crawledAt,
      hash,
      provenance,
    ],
  );
  const sourceIdValue = source.rows[0]?.id ?? id;

  // Статья — владелец чанков: у чанка ровно один владелец (документ или статья).
  await client.query(
    `INSERT INTO kb_articles (
       id, tenant_id, title, body_md, status, version, valid_from, owner, approved_at
     ) VALUES ($1, $2, $3, $4, 'published', 1, $5, 'customer-site', $5)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       body_md = EXCLUDED.body_md,
       status = 'published',
       valid_from = EXCLUDED.valid_from,
       owner = EXCLUDED.owner,
       approved_at = EXCLUDED.approved_at`,
    [id, tenantId, page.title, page.text, page.crawledAt],
  );

  const content: SourceContent = {
    url: page.url,
    title: page.title,
    sectionPath: page.sectionPath,
    text: page.text,
    crawledAt: page.crawledAt,
  };
  const chunkList = chunkSource(content);

  // Старые чанки статьи заменяются целиком: содержание источника обновилось.
  await client.query("DELETE FROM kb_chunks WHERE tenant_id = $1 AND article_id = $2", [
    tenantId,
    id,
  ]);

  const pageNo = pageNoFrom(page.sectionPath);
  for (const chunk of chunkList) {
    const vector = await embeddingProvider.embed(chunk.text);
    await client.query(
      `INSERT INTO kb_chunks (
         tenant_id, article_id, chunk_no, page_no, text, search_vector, embedding
       ) VALUES ($1, $2, $3, $4, $5, to_tsvector('russian', $5), $6::vector)`,
      [tenantId, id, chunk.chunkNo, pageNo, chunk.text, vectorLiteral(vector)],
    );
  }

  // История снимков: предыдущий снимок закрывается, новый становится текущим.
  await client.query(
    `UPDATE kb_source_snapshots SET valid_to = $3
     WHERE tenant_id = $1 AND source_id = $2 AND valid_to IS NULL AND snapshot_hash <> $4`,
    [tenantId, sourceIdValue, page.crawledAt, hash],
  );
  await client.query(
    `INSERT INTO kb_source_snapshots (
       tenant_id, source_id, snapshot_hash, provenance, crawled_at, status, valid_from, valid_to
     ) VALUES ($1, $2, $3, $4, $5, 'approved_by_customer', $5, NULL)
     ON CONFLICT (tenant_id, source_id, snapshot_hash) DO NOTHING`,
    [tenantId, sourceIdValue, hash, provenance, page.crawledAt],
  );

  return { sources: 1, chunks: chunkList.length };
}

/** Вектор в формате PostgreSQL: `[0.1,0.2]`. */
function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Обходит сайт заказчика и импортирует собранные страницы.
 *
 * @param options параметры обхода и импорта.
 */
export async function importDocsSite(options: ImportDocsSiteOptions): Promise<ImportReport> {
  const report = await crawlSite(options);
  const pages = [...report.pages, ...(options.extraPages ?? [])];
  const imported = await importCrawledPages(pages, options);
  return {
    sources: imported.sources,
    chunks: imported.chunks,
    failed: imported.failed + report.failed,
  };
}

export type { Chunk };
