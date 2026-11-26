// Интеграционный тест среза «импорт фида каталога».
//
// Собирает срез целиком: разбор YML-фида → импорт в базу → структурный поиск
// по импортированному каталогу. Команда проверки из тикета:
//
//   npm run test -- tests/integration/12-import-catalog-feed.test.ts
//
// Тест работает на локальной базе среза (DATABASE_URL) и на собственной фикстуре
// в стиле фида заказчика: полный файл на 292 МБ в тест не кладётся.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importFeed } from "@/import/catalog";
import { catalog } from "@/modules/catalog";
import { cleanupTenant, createTenant, ensureSchema, uniqueSuffix, withClient } from "../catalog/helpers/db";

const FIXTURE_DATE = "2026-11-25 14:12";

/** Фикстура в стиле фида заказчика: дерево категорий, параметры, ценовые случаи. */
function buildFixture(): string {
  const categories = [
    { id: "8", parentId: null, name: "Программы для работы с текстом" },
    { id: "6", parentId: "8", name: "Программы для распознавания текста" },
    { id: "11", parentId: "6", name: "Content AI Screenshot Reader" },
  ];

  const offers = [
    {
      id: "504",
      groupId: "556",
      available: "false",
      name: "Adobe Systems Adobe InCopy CC, лицензия, 12 мес.",
      vendor: "Adobe Systems",
      vendorCode: "",
      price: "1200.00",
      oldprice: "1500.00",
      categoryId: "6",
      description: "Лицензия для коммерческих организаций",
      params: [
        ["Срок действия", "12 мес."],
        ["Тип лицензии", "Подписка"],
        ["Язык интерфейса", "Русская версия"],
        ["Язык интерфейса", "Мультиязычный"],
      ],
    },
    {
      id: "505",
      groupId: "",
      available: "true",
      name: "Content AI Screenshot Reader",
      vendor: "Софтлайн",
      vendorCode: "",
      price: "0.00",
      oldprice: "0.00",
      categoryId: "11",
      description: "Цена не подтверждена заказчиком",
      params: [
        ["Срок действия", "36 мес."],
        ["Тип лицензии", "Обновление"],
      ],
    },
    {
      id: "506",
      groupId: "",
      available: "true",
      name: "Сумматор документов",
      vendor: "",
      vendorCode: "",
      price: "99.90",
      oldprice: "",
      categoryId: "8",
      description: "Внутренняя позиция без вендора",
      params: [["Срок действия", "12 мес."]],
    },
  ];

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE yml_catalog SYSTEM "shops.dtd">',
    `<yml_catalog date="${FIXTURE_DATE}">`,
    "\t<shop>",
    "\t\t<name>store.softline.ru</name>",
    "\t\t<company>store.softline.ru</company>",
    "\t\t<url>https://store.softline.ru</url>",
    "\t\t<currencies>",
    '\t\t\t<currency id="RUR" rate="1"/>',
    "\t\t</currencies>",
    "\t\t<categories>",
  ];
  for (const category of categories) {
    const parent = category.parentId ? ` parentId="${category.parentId}"` : "";
    lines.push(`\t\t\t<category id="${category.id}"${parent}>${category.name}</category>`);
  }
  lines.push("\t\t</categories>", "\t\t<offers>");

  for (const offer of offers) {
    const groupAttribute = offer.groupId ? ` group_id="${offer.groupId}"` : "";
    lines.push(`\t\t<offer id="${offer.id}"${groupAttribute} available="${offer.available}">`);
    lines.push(`\t\t\t<name>${offer.name}</name>`);
    lines.push(`\t\t\t<vendor>${offer.vendor}</vendor>`);
    lines.push("\t\t\t<vendorUrl>https://store.softline.ru/vendor/</vendorUrl>");
    lines.push(`\t\t\t<vendorCode>${offer.vendorCode}</vendorCode>`);
    lines.push(`\t\t\t<url>https://store.softline.ru/item/${offer.id}/</url>`);
    lines.push(`\t\t\t<price>${offer.price}</price>`);
    lines.push(`\t\t\t<oldprice>${offer.oldprice}</oldprice>`);
    lines.push("\t\t\t<currencyId>RUR</currencyId>");
    lines.push(`\t\t\t<categoryId>${offer.categoryId}</categoryId>`);
    lines.push("\t\t\t<picture>https://img.softline.com/picture.png</picture>");
    lines.push("\t\t\t<delivery>true</delivery>");
    lines.push("\t\t\t<pickup>false</pickup>");
    lines.push(`\t\t\t<description>${offer.description}</description>`);
    for (const [name, value] of offer.params) {
      lines.push(`\t\t\t<param name="${name}">${value}</param>`);
    }
    lines.push("\t\t</offer>");
  }
  lines.push("\t\t</offers>", "\t</shop>", "</yml_catalog>", "");
  return lines.join("\n");
}

describe("интеграция среза импорта фида каталога", () => {
  let tenantId: string;
  let tenantSlug: string;
  let feedPath: string;
  let fixtureHash: string;

  beforeAll(async () => {
    await ensureSchema();
    tenantSlug = `catalog-integration-${uniqueSuffix()}`;
    tenantId = await createTenant(tenantSlug);
    const dir = await mkdtemp(join(tmpdir(), "catalog-integration-"));
    feedPath = join(dir, "Mindbox.yml.gz.xml");
    const fixture = buildFixture();
    await writeFile(feedPath, fixture, "utf8");
    fixtureHash = createHash("sha256").update(fixture, "utf8").digest("hex");
  });

  afterAll(async () => {
    await cleanupTenant(tenantSlug);
  });

  it("импортирует фид, разворачивает категории и ищет по каталогу", async () => {
    const report = await importFeed(feedPath, { tenantId, sourceUrl: null });

    expect(report.total).toBe(3);
    expect(report.imported).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.categories).toBe(3);
    expect(report.feedDate).toBe("2026-11-25T14:12:00.000Z");
    expect(report.snapshotHash).toBe(fixtureHash);
    expect(report.sourceKind).toBe("local_snapshot");
    expect(report.availableCount).toBe(2);
    expect(report.pricedCount).toBe(2);
    expect(report.paramNames).toBe(3);
    expect(report.paramValues).toBe(7);

    const counts = await withClient(async (client) => {
      const result = await client.query<{ products: string; categories: string; snapshots: string }>(
        `SELECT (SELECT count(*) FROM products WHERE tenant_id = $1)::text AS products,
                (SELECT count(*) FROM catalog_categories WHERE tenant_id = $1)::text AS categories,
                (SELECT count(*) FROM catalog_snapshots WHERE tenant_id = $1)::text AS snapshots`,
        [tenantId],
      );
      return result.rows[0];
    });
    expect(Number(counts?.products)).toBe(3);
    expect(Number(counts?.categories)).toBe(3);
    expect(Number(counts?.snapshots)).toBe(1);

    // Полный путь категории вычислен при импорте.
    const paths = await withClient(async (client) => {
      const result = await client.query<{ category_id: string; path: string }>(
        `SELECT category_id, path FROM catalog_categories WHERE tenant_id = $1 ORDER BY category_id`,
        [tenantId],
      );
      return result.rows;
    });
    expect(paths.find((row) => row.category_id === "11")?.path).toBe(
      "Программы для работы с текстом / Программы для распознавания текста / Content AI Screenshot Reader",
    );
  });

  it("повторный импорт идемпотентен: дублей нет, позиция обновлена", async () => {
    const changed = (await readFile(feedPath, "utf8")).replace(
      "<price>1200.00</price>",
      "<price>1300.00</price>",
    );
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

    // История снимков сохраняется: прошлый снимок не удалён.
    const snapshots = await withClient(async (client) => {
      const result = await client.query<{ count: string; current: string }>(
        `SELECT count(*)::text AS count, count(*) FILTER (WHERE is_current)::text AS current
         FROM catalog_snapshots WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0];
    });
    expect(Number(snapshots?.count)).toBe(2);
    expect(Number(snapshots?.current)).toBe(1);
  });

  it("структурный поиск находит позиции и фильтрует по параметрам", async () => {
    const byName = await catalog.search("Screenshot Reader", { tenantId });
    expect(byName.map((hit) => hit.offerId)).toEqual(["505"]);

    const byOfferId = await catalog.search("506", { tenantId });
    expect(byOfferId.map((hit) => hit.offerId)).toContain("506");

    const byVendor = await catalog.search("", { tenantId, vendor: "Софтлайн" });
    expect(byVendor.map((hit) => hit.offerId)).toEqual(["505"]);

    const byCategory = await catalog.search("", { tenantId, categoryId: "8" });
    expect(byCategory.map((hit) => hit.offerId).sort()).toEqual(["504", "505", "506"]);

    const byParam = await catalog.search("", { tenantId, params: { "Срок действия": "36 мес." } });
    expect(byParam.map((hit) => hit.offerId)).toEqual(["505"]);

    const availableOnly = await catalog.search("", { tenantId, availableOnly: true });
    expect(availableOnly.map((hit) => hit.offerId).sort()).toEqual(["505", "506"]);

    const missing = await catalog.search("позиции такого названия нет", { tenantId });
    expect(missing).toEqual([]);
  });

  it("цена не подтверждена заказчиком помечается, карточка хранит провенанс", async () => {
    const hits = await catalog.search("Screenshot Reader", { tenantId });
    const hit = hits[0];
    expect(hit?.price).toBe(0);
    expect(hit?.priceConfirmed).toBe(false);
    expect(hit?.available).toBe(true);
    expect(hit?.feedDate).toBe("2026-11-25T14:12:00.000Z");
    expect(hit?.snapshotHash).toBe(createHash("sha256")
      .update((await readFile(feedPath, "utf8")).replace("<price>1200.00</price>", "<price>1300.00</price>"), "utf8")
      .digest("hex"));

    const item = await catalog.getByOfferId("504", { tenantId });
    expect(item?.price).toBe(1300);
    expect(item?.priceConfirmed).toBe(true);
    expect(item?.categoryPath).toBe(
      "Программы для работы с текстом / Программы для распознавания текста",
    );
    expect(item?.params).toEqual({
      "Срок действия": "12 мес.",
      "Тип лицензии": "Подписка",
      "Язык интерфейса": ["Русская версия", "Мультиязычный"],
    });
  });

  it("в схеме каталога нет векторного индекса", async () => {
    const vectorIndexes = await withClient(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename IN ('products', 'catalog_categories', 'price_rules', 'catalog_snapshots')
           AND indexdef ILIKE '%vector(%)%'
           AND indexdef NOT ILIKE '%to_tsvector%'`,
      );
      return result.rows[0];
    });
    expect(Number(vectorIndexes?.count)).toBe(0);

    // Векторной колонки у каталога нет вовсе.
    const vectorColumns = await withClient(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('products', 'catalog_categories', 'price_rules', 'catalog_snapshots')
           AND udt_name = 'vector'`,
      );
      return result.rows[0];
    });
    expect(Number(vectorColumns?.count)).toBe(0);
  });
});
