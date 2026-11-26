// Запись фида в базу: снимок, дерево категорий, позиции пачками.
//
// Повторный импорт — идемпотентный upsert по `offer/@id`: позиция обновляется
// и переводится на новый снимок, дубль не создаётся. Позиция без `offer/@id`
// пропускается и учитывается в отчёте; позиция без имени — ошибка записи.
// Пачка записывается одной транзакцией: падение не оставляет половину каталога.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PoolClient } from "pg";
import { parseFeed, feedDateToIsoUtc, type ParsedCategory, type ParsedOffer } from "./parse";
import { openFeedSource, type FeedSource, type SourceKind } from "./source";
import { getPool } from "@/modules/catalog/pool";

export type ImportReport = {
  /** Позиций встречено в фиде. */
  total: number;
  /** Позиций записано (вставлено или обновлено). */
  imported: number;
  /** Пропущено: нет `offer/@id`. */
  skipped: number;
  /** Ошибок записи: нет имени или сбой базы. */
  failed: number;
  /** Узлов дерева категорий. */
  categories: number;
  durationMs: number;
  /** Дата фида из его содержимого. */
  feedDate: string | null;
  /** SHA-256 снимка. */
  snapshotHash: string;
  /** URL живого источника истины, если фид брался из сети. */
  sourceUrl: string | null;
  /** Вид источника: живой фид или локальный снимок. */
  sourceKind: SourceKind;
  /** Идентификатор снимка в `catalog_snapshots`. */
  snapshotId: string;
  /** Позиций с `available=true` в этом снимке. */
  availableCount: number;
  /** Позиций с ценой больше нуля. */
  pricedCount: number;
  /** Разных имён параметров в фиде. */
  paramNames: number;
  /** Всего значений параметров в фиде. */
  paramValues: number;
  /** Импорт продолжен с файла состояния. */
  resumed: boolean;
  /** Пиковое потребление памяти процессом, МБ. */
  peakMemoryMb: number;
};

export type ImportOptions = {
  /** UUID арендатора; если не задан, берётся `demo-tenant`. */
  tenantId?: string;
  /** Слаг арендатора; по умолчанию `demo-tenant`. */
  tenantSlug?: string;
  /** URL живого источника истины. */
  sourceUrl?: string | null;
  /** Путь к запасному снимку, если живой источник недоступен. */
  fallbackPath?: string | null;
  /** Размер пачки позиций. */
  batchSize?: number;
  /** Файл состояния для продолжения прерванного импорта. */
  statePath?: string | null;
  /** Каталог для снимков и файла состояния. */
  workDir?: string;
};

type ImportState = {
  snapshotHash: string;
  lastOfferId: string;
  imported: number;
};

const DEFAULT_BATCH_SIZE = 1000;

function isRemote(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

async function resolveTenant(
  client: PoolClient,
  options: ImportOptions,
): Promise<string> {
  if (options.tenantId) return options.tenantId;
  const slug = options.tenantSlug ?? "demo-tenant";
  const result = await client.query<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [slug, slug],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("арендатор каталога не создан");
  return id;
}

async function ensureSnapshot(
  client: PoolClient,
  tenantId: string,
  source: FeedSource,
  feedDate: string | null,
): Promise<string> {
  const hash = source.snapshotHash;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM catalog_snapshots WHERE tenant_id = $1 AND snapshot_hash = $2`,
    [tenantId, hash],
  );
  const found = existing.rows[0];
  if (found) {
    await client.query(
      `UPDATE catalog_snapshots
          SET source_url = $2, feed_date = COALESCE($3, feed_date), fetched_at = now(),
              source_kind = $4, is_current = true
        WHERE id = $1`,
      [found.id, source.sourceUrl ?? source.snapshotPath, feedDate, source.sourceKind],
    );
    await client.query(`UPDATE catalog_snapshots SET is_current = false WHERE tenant_id = $1 AND id <> $2`, [
      tenantId,
      found.id,
    ]);
    return found.id;
  }

  const created = await client.query<{ id: string }>(
    `INSERT INTO catalog_snapshots
       (tenant_id, source_url, feed_date, fetched_at, snapshot_hash, is_current, source_kind)
     VALUES ($1, $2, $3, now(), $4, true, $5)
     RETURNING id`,
    [tenantId, source.sourceUrl ?? source.snapshotPath, feedDate, hash, source.sourceKind],
  );
  const id = created.rows[0]?.id;
  if (!id) throw new Error("снимок каталога не создан");
  await client.query(`UPDATE catalog_snapshots SET is_current = false WHERE tenant_id = $1 AND id <> $2`, [
    tenantId,
    id,
  ]);
  return id;
}

async function writeCategories(
  client: PoolClient,
  tenantId: string,
  categories: ParsedCategory[],
): Promise<void> {
  if (categories.length === 0) return;
  const ids = categories.map((category) => category.id);
  const parents = categories.map((category) => category.parentId);
  const names = categories.map((category) => category.name);
  const paths = categories.map((category) => category.path);
  await client.query(
    `INSERT INTO catalog_categories (tenant_id, category_id, parent_id, name, path)
     SELECT $1, u.category_id, u.parent_id, u.name, u.path
     FROM ROWS FROM (unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[]))
       AS u(category_id, parent_id, name, path)
     ON CONFLICT (tenant_id, category_id) DO UPDATE
       SET parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, path = EXCLUDED.path`,
    [tenantId, ids, parents, names, paths],
  );
}

async function writeOffers(
  client: PoolClient,
  tenantId: string,
  snapshotId: string,
  offers: ParsedOffer[],
): Promise<void> {
  if (offers.length === 0) return;
  const offerIds = offers.map((offer) => offer.id);
  const groupIds = offers.map((offer) => offer.groupId);
  const names = offers.map((offer) => offer.name);
  const vendors = offers.map((offer) => offer.vendor);
  const vendorUrls = offers.map((offer) => offer.vendorUrl);
  const productUrls = offers.map((offer) => offer.url);
  const prices = offers.map((offer) => String(offer.price));
  const oldPrices = offers.map((offer) => (offer.oldPrice === null ? null : String(offer.oldPrice)));
  const currencies = offers.map((offer) => offer.currencyId);
  const categoryIds = offers.map((offer) => offer.categoryId);
  const availables = offers.map((offer) => String(offer.available));
  const deliveries = offers.map((offer) => (offer.delivery === null ? null : String(offer.delivery)));
  const pickups = offers.map((offer) => (offer.pickup === null ? null : String(offer.pickup)));
  const descriptions = offers.map((offer) => offer.description);
  const params = offers.map((offer) => JSON.stringify(offer.params));

  await client.query(
    `INSERT INTO products (
       tenant_id, offer_id, group_id, name, vendor, vendor_url, product_url,
       price, old_price, currency_id, category_id, available, delivery, pickup,
       description, params, snapshot_id, status, published)
     SELECT $1, u.offer_id, u.group_id, u.name, u.vendor, u.vendor_url, u.product_url,
            u.price::numeric, u.old_price::numeric, u.currency_id, u.category_id,
            u.available::boolean, u.delivery::boolean, u.pickup::boolean,
            u.description, u.params::jsonb, $2, 'approved_by_customer', true
     FROM ROWS FROM (
       unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::text[]),
       unnest($7::text[]), unnest($8::text[]), unnest($9::text[]), unnest($10::text[]),
       unnest($11::text[]), unnest($12::text[]), unnest($13::text[]), unnest($14::text[]),
       unnest($15::text[]), unnest($16::text[]), unnest($17::text[])
     ) AS u(
       offer_id, group_id, name, vendor, vendor_url, product_url, price, old_price,
       currency_id, category_id, available, delivery, pickup, description, params
     )
     ON CONFLICT (tenant_id, offer_id) DO UPDATE SET
       group_id = EXCLUDED.group_id,
       name = EXCLUDED.name,
       vendor = EXCLUDED.vendor,
       vendor_url = EXCLUDED.vendor_url,
       product_url = EXCLUDED.product_url,
       price = EXCLUDED.price,
       old_price = EXCLUDED.old_price,
       currency_id = EXCLUDED.currency_id,
       category_id = EXCLUDED.category_id,
       available = EXCLUDED.available,
       delivery = EXCLUDED.delivery,
       pickup = EXCLUDED.pickup,
       description = EXCLUDED.description,
       params = EXCLUDED.params,
       snapshot_id = EXCLUDED.snapshot_id,
       status = EXCLUDED.status,
       published = EXCLUDED.published`,
    [
      tenantId,
      snapshotId,
      offerIds,
      groupIds,
      names,
      vendors,
      vendorUrls,
      productUrls,
      prices,
      oldPrices,
      currencies,
      categoryIds,
      availables,
      deliveries,
      pickups,
      descriptions,
      params,
    ],
  );
}

async function readState(statePath: string | null, snapshotHash: string): Promise<ImportState | null> {
  if (!statePath) return null;
  try {
    const content = await readFile(resolve(statePath), "utf8");
    const parsed = JSON.parse(content) as ImportState;
    if (parsed.snapshotHash !== snapshotHash) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(statePath: string | null, state: ImportState): Promise<void> {
  if (!statePath) return;
  const target = resolve(statePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(state), "utf8");
}

export type InspectReport = {
  total: number;
  categories: number;
  availableCount: number;
  pricedCount: number;
  paramNames: number;
  paramValues: number;
  skipped: number;
  failed: number;
  feedDate: string | null;
  snapshotHash: string;
  sourceKind: SourceKind;
  sourceUrl: string | null;
  durationMs: number;
  /** Пиковое потребление памяти процессом, МБ. */
  peakMemoryMb: number;
};

/**
 * Разбирает фид, ничего не записывая в базу: проверка источника и счётчики.
 * Нужен, чтобы увидеть, что живой фид читается, до тяжёлой записи в базу.
 */
export async function inspectFeed(
  source: string,
  fallbackPath: string | null = null,
): Promise<InspectReport> {
  const startedAt = Date.now();
  const feedSource = await openFeedSource({
    sourceUrl: isRemote(source) ? source : null,
    fallbackPath: isRemote(source) ? fallbackPath : source,
  });

  const paramNames = new Set<string>();
  let paramValues = 0;
  let total = 0;
  let categories = 0;
  let availableCount = 0;
  let pricedCount = 0;
  let skipped = 0;
  let failed = 0;
  let feedDate: string | null = null;

  for await (const record of parseFeed(feedSource.stream)) {
    if (record.kind === "meta") {
      feedDate = feedDateToIsoUtc(record.feedDate);
      continue;
    }
    if (record.kind === "category") {
      categories += 1;
      continue;
    }
    const offer = record.offer;
    total += 1;
    if (offer.id === "") {
      skipped += 1;
      continue;
    }
    if (offer.name.trim() === "") {
      failed += 1;
      continue;
    }
    for (const name of Object.keys(offer.params)) paramNames.add(name);
    for (const value of Object.values(offer.params)) {
      paramValues += Array.isArray(value) ? value.length : 1;
    }
    if (offer.available) availableCount += 1;
    if (offer.price > 0) pricedCount += 1;
  }

  return {
    total,
    categories,
    availableCount,
    pricedCount,
    paramNames: paramNames.size,
    paramValues,
    skipped,
    failed,
    feedDate,
    snapshotHash: feedSource.snapshotHash,
    sourceKind: feedSource.sourceKind,
    sourceUrl: feedSource.sourceUrl,
    durationMs: Date.now() - startedAt,
    peakMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

/**
 * Импортирует фид в каталог.
 *
 * `source` — путь к локальному снимку или URL живого фида. Для URL живой фид
 * скачивается потоком с распаковкой gzip на лету; при недоступности берётся
 * `options.fallbackPath`, и это не ошибка.
 */
export async function importFeed(
  source: string | FeedSource,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const startedAt = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const workDir = options.workDir ?? resolve(process.cwd(), ".cache", "feed");
  const statePath = options.statePath ?? resolve(workDir, "import-state.json");

  const feedSource: FeedSource =
    typeof source === "string" && !isRemote(source)
      ? await openFeedSource({ fallbackPath: source, workDir })
      : typeof source === "string"
        ? await openFeedSource({
            sourceUrl: source,
            fallbackPath: options.fallbackPath ?? null,
            workDir,
          })
        : source;

  // Провенанс: живой фид — источник истины, даже если импорт шёл с запасного
  // снимка на диске. Так по карточке видно, откуда взяты позиции.
  const provenanceUrl = feedSource.sourceUrl ?? options.sourceUrl ?? null;
  if (provenanceUrl !== null && feedSource.sourceUrl === null) {
    feedSource.sourceUrl = provenanceUrl;
  }

  const pool = getPool();
  const client = await pool.connect();
  const paramNames = new Set<string>();
  let paramValues = 0;
  let availableCount = 0;
  let pricedCount = 0;
  let total = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let categories = 0;
  let feedDate: string | null = null;
  let snapshotId = "";
  let resumed = false;

  try {
    const tenantId = await resolveTenant(client, options);
    const state = await readState(statePath, feedSource.snapshotHash);
    resumed = state !== null;
    let skipUntilSeen = state !== null;
    let lastOfferId = state?.lastOfferId ?? "";
    imported = state?.imported ?? 0;

    const categoryBuffer: ParsedCategory[] = [];
    const offerBuffer: ParsedOffer[] = [];

    const flushOffers = async (): Promise<void> => {
      if (offerBuffer.length === 0) return;
      const batch = offerBuffer.splice(0, offerBuffer.length);
      await client.query("BEGIN");
      try {
        await writeOffers(client, tenantId, snapshotId, batch);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        offerBuffer.unshift(...batch);
        throw error;
      }
      imported += batch.length;
      lastOfferId = batch[batch.length - 1]?.id ?? lastOfferId;
      await writeState(statePath, {
        snapshotHash: feedSource.snapshotHash,
        lastOfferId,
        imported,
      });
    };

    for await (const record of parseFeed(feedSource.stream)) {
      if (record.kind === "meta") {
        feedDate = feedDateToIsoUtc(record.feedDate);
        snapshotId = await ensureSnapshot(client, tenantId, feedSource, feedDate);
        continue;
      }

      if (record.kind === "category") {
        categoryBuffer.push(record.category);
        categories += 1;
        if (categoryBuffer.length >= batchSize) {
          const batch = categoryBuffer.splice(0, categoryBuffer.length);
          await client.query("BEGIN");
          try {
            await writeCategories(client, tenantId, batch);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            categoryBuffer.unshift(...batch);
            throw error;
          }
        }
        continue;
      }

      const offer = record.offer;
      total += 1;

      // Позиции до точки обрыва уже записаны в прошлом запуске: при продолжении
      // импорта они не считаются ни в skipped, ни в failed.
      if (skipUntilSeen) {
        if (offer.id === lastOfferId) skipUntilSeen = false;
        continue;
      }

      if (offer.id === "") {
        skipped += 1;
        continue;
      }
      if (offer.name.trim() === "") {
        failed += 1;
        continue;
      }

      for (const name of Object.keys(offer.params)) {
        paramNames.add(name);
      }
      for (const value of Object.values(offer.params)) {
        paramValues += Array.isArray(value) ? value.length : 1;
      }
      if (offer.available) availableCount += 1;
      if (offer.price > 0) pricedCount += 1;

      offerBuffer.push(offer);
      if (offerBuffer.length >= batchSize) await flushOffers();
    }

    if (categoryBuffer.length > 0) {
      const batch = categoryBuffer.splice(0, categoryBuffer.length);
      await client.query("BEGIN");
      try {
        await writeCategories(client, tenantId, batch);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    await flushOffers();

    if (snapshotId) {
      await client.query(
        `UPDATE catalog_snapshots SET offers_count = $2, categories_count = $3 WHERE id = $1`,
        [snapshotId, imported, categories],
      );
    }
    // Импорт завершён: файл состояния больше не нужен, следующий запуск
    // с тем же снимком идёт с нуля.
    await rm(resolve(statePath), { force: true }).catch(() => undefined);
  } finally {
    client.release();
  }

  return {
    total,
    imported,
    skipped,
    failed,
    categories,
    durationMs: Date.now() - startedAt,
    feedDate,
    snapshotHash: feedSource.snapshotHash,
    sourceUrl: feedSource.sourceUrl,
    sourceKind: feedSource.sourceKind,
    snapshotId,
    availableCount,
    pricedCount,
    paramNames: paramNames.size,
    paramValues,
    resumed,
    peakMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}
