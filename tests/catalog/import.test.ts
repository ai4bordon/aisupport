import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importFeed } from "@/import/catalog";
import { cleanupTenant, createTenant, ensureSchema, uniqueSuffix, withClient } from "./helpers/db";

// Фикстура — фрагмент фида в стиле YML: магазин, две вложенные категории,
// пять позиций (одна без offer/@id, одна без имени, две с пустым vendorCode).
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE yml_catalog SYSTEM "shops.dtd">
<yml_catalog date="2026-11-25 14:12">
<shop>
<name>store.softline.ru</name>
<company>store.softline.ru</company>
<url>https://store.softline.ru</url>
<currencies>
<currency id="RUR" rate="1"/>
</currencies>
<categories>
<category id="8">Программы для работы с текстом</category>
<category id="6" parentId="8">Программы для распознавания текста</category>
</categories>
<offers>
<offer id="504" group_id="556" available="false">
<name>Adobe InCopy CC</name>
<vendor>Adobe Systems</vendor>
<vendorUrl>https://store.softline.ru/adobe/</vendorUrl>
<vendorCode></vendorCode>
<url>https://store.softline.ru/adobe/504/</url>
<price>1200.00</price>
<oldprice>1500.00</oldprice>
<currencyId>RUR</currencyId>
<categoryId>6</categoryId>
<picture>https://img.softline.com/pic.png</picture>
<delivery>false</delivery>
<pickup>false</pickup>
<description>Лицензия для коммерческих организаций, 12 мес.</description>
<group_id>556</group_id>
<param name="Срок действия">12 мес.</param>
<param name="Язык интерфейса">Русская версия</param>
<param name="Язык интерфейса">Мультиязычный</param>
</offer>
<offer id="505" available="true">
<name>Позиция с пустым vendorCode раз</name>
<vendor>Без кода</vendor>
<vendorCode></vendorCode>
<url>https://store.softline.ru/x/505/</url>
<price>0.00</price>
<currencyId>RUR</currencyId>
<categoryId>8</categoryId>
<delivery>true</delivery>
<pickup>false</pickup>
<description>Цена не подтверждена</description>
</offer>
<offer id="506" available="true">
<name>Позиция с пустым vendorCode два</name>
<vendor>Без кода</vendor>
<vendorCode></vendorCode>
<url>https://store.softline.ru/x/506/</url>
<price>99.90</price>
<currencyId>RUR</currencyId>
<categoryId>8</categoryId>
<delivery>true</delivery>
<pickup>false</pickup>
<description>Вторая позиция того же вендора</description>
</offer>
<offer available="true">
<name>Позиция без offer/@id</name>
<vendor>Без кода</vendor>
<url>https://store.softline.ru/x/999/</url>
<price>10.00</price>
<currencyId>RUR</currencyId>
</offer>
<offer id="507">
<vendor>Без имени</vendor>
<url>https://store.softline.ru/x/507/</url>
<price>10.00</price>
<currencyId>RUR</currencyId>
</offer>
</offers>
</shop>
</yml_catalog>
`;

describe("импорт фида каталога", () => {
  let tenantId: string;
  let tenantSlug: string;
  let feedPath: string;
  let feedHash: string;

  beforeAll(async () => {
    await ensureSchema();
    tenantSlug = `catalog-import-${uniqueSuffix()}`;
    tenantId = await createTenant(tenantSlug);
    const dir = await mkdtemp(join(tmpdir(), "catalog-feed-"));
    feedPath = join(dir, "feed.xml");
    await writeFile(feedPath, FEED, "utf8");
    feedHash = createHash("sha256").update(FEED, "utf8").digest("hex");
  });

  afterAll(async () => {
    await cleanupTenant(tenantSlug);
  });

  it("импортирует позиции с ценой, наличием, вендором, категорией и параметрами", async () => {
    const report = await importFeed(feedPath, { tenantId, sourceUrl: null });

    expect(report.total).toBe(5);
    expect(report.imported).toBe(3);
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.categories).toBe(2);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

    const rows = await withClient(async (client) => {
      const result = await client.query<{
        offer_id: string;
        name: string;
        vendor: string | null;
        price: string;
        available: boolean;
        group_id: string | null;
        params: Record<string, string | string[]>;
        category_path: string | null;
      }>(
        `SELECT p.offer_id, p.name, p.vendor, p.price, p.available, p.group_id, p.params,
                c.path AS category_path
         FROM products p
         LEFT JOIN catalog_categories c
           ON c.tenant_id = p.tenant_id AND c.category_id = p.category_id
         WHERE p.tenant_id = $1 ORDER BY p.offer_id`,
        [tenantId],
      );
      return result.rows;
    });

    expect(rows).toHaveLength(3);
    const first = rows.find((row) => row.offer_id === "504");
    expect(first).toBeDefined();
    expect(first?.name).toBe("Adobe InCopy CC");
    expect(first?.vendor).toBe("Adobe Systems");
    expect(Number(first?.price)).toBe(1200);
    expect(first?.available).toBe(false);
    expect(first?.group_id).toBe("556");
    expect(first?.category_path).toBe("Программы для работы с текстом / Программы для распознавания текста");
    expect(first?.params).toEqual({
      "Срок действия": "12 мес.",
      "Язык интерфейса": ["Русская версия", "Мультиязычный"],
    });
  });

  it("разворачивает дерево категорий в полный путь", async () => {
    const rows = await withClient(async (client) => {
      const result = await client.query<{ category_id: string; parent_id: string | null; path: string }>(
        `SELECT category_id, parent_id, path FROM catalog_categories
         WHERE tenant_id = $1 ORDER BY category_id`,
        [tenantId],
      );
      return result.rows;
    });

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.category_id === "8")?.path).toBe("Программы для работы с текстом");
    expect(rows.find((row) => row.category_id === "6")?.path).toBe(
      "Программы для работы с текстом / Программы для распознавания текста",
    );
  });

  it("не объединяет две позиции с одинаковым пустым vendorCode", async () => {
    const rows = await withClient(async (client) => {
      const result = await client.query<{ offer_id: string; name: string }>(
        `SELECT offer_id, name FROM products WHERE tenant_id = $1 ORDER BY offer_id`,
        [tenantId],
      );
      return result.rows;
    });

    const sameVendor = rows.filter((row) => row.offer_id === "505" || row.offer_id === "506");
    expect(sameVendor).toHaveLength(2);
    expect(new Set(sameVendor.map((row) => row.offer_id)).size).toBe(2);
  });

  it("повторный импорт обновляет позицию, а не создаёт дубль", async () => {
    const changed = FEED.replace("<price>1200.00</price>", "<price>1300.00</price>");
    await writeFile(feedPath, changed, "utf8");

    const report = await importFeed(feedPath, { tenantId, sourceUrl: null });
    expect(report.imported).toBe(3);

    const state = await withClient(async (client) => {
      const result = await client.query<{ count: string; price: string }>(
        `SELECT count(*)::text AS count, max(price)::text AS price FROM products WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0];
    });

    expect(Number(state?.count)).toBe(3);
    expect(Number(state?.price)).toBe(1300);
  });

  it("продолжает прерванный импорт по файлу состояния", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-feed-state-"));
    const statePath = join(dir, "import-state.json");
    const hash = createHash("sha256").update(await readFile(feedPath, "utf8"), "utf8").digest("hex");
    await writeFile(
      statePath,
      JSON.stringify({ snapshotHash: hash, lastOfferId: "505", imported: 1 }),
      "utf8",
    );

    const report = await importFeed(feedPath, {
      tenantId,
      sourceUrl: null,
      statePath,
    });

    expect(report.resumed).toBe(true);
    // Первая позиция уже была записана до обрыва: продолжение начинается
    // со следующей и не создаёт дубль.
    expect(report.imported).toBe(2);
    const rows = await withClient(async (client) => {
      const result = await client.query<{ offer_id: string }>(
        `SELECT offer_id FROM products WHERE tenant_id = $1 ORDER BY offer_id`,
        [tenantId],
      );
      return result.rows;
    });
    expect(rows.map((row) => row.offer_id)).toEqual(["504", "505", "506"]);
  });

  it("фиксирует в провенансе дату фида и хеш снимка", async () => {
    const snapshots = await withClient(async (client) => {
      const result = await client.query<{
        source_url: string;
        feed_date: Date | null;
        snapshot_hash: string;
        is_current: boolean;
        source_kind: string;
        offers_count: number;
        categories_count: number;
      }>(
        `SELECT source_url, feed_date, snapshot_hash, is_current, source_kind,
                offers_count, categories_count
         FROM catalog_snapshots WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      );
      return result.rows;
    });

    // История снимков не перетирается: первый снимок остаётся в базе,
    // текущим становится последний.
    expect(snapshots).toHaveLength(2);
    const first = snapshots[0];
    expect(first?.is_current).toBe(false);
    expect(first?.source_kind).toBe("local_snapshot");
    expect(first?.feed_date?.toISOString()).toBe("2026-11-25T14:12:00.000Z");
    expect(first?.snapshot_hash).toBe(feedHash);
    expect(first?.offers_count).toBe(3);
    expect(first?.categories_count).toBe(2);

    const current = snapshots[1];
    expect(current?.is_current).toBe(true);
    expect(current?.snapshot_hash).not.toBe(feedHash);
    expect(current?.feed_date?.toISOString()).toBe("2026-11-25T14:12:00.000Z");
  });
});
