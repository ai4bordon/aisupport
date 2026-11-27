import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  extractProductQuery,
  extractSlots,
  lookupCatalog,
  type RequirementSlots,
} from "@/core/catalog-lookup";
import { loadSlots, saveSlots } from "@/core/slots";
import { containsUrl, stripUrls } from "@/core/no-urls";
import { closePool, getPool } from "@/db/pool";
import { getPool as getCatalogPool } from "@/modules/catalog/pool";
import { cleanupTenant, createTenant, ensureSchema, uniqueSuffix } from "./helpers/db";

/**
 * Регрессии по находкам аудита BUGSAUDIT-2026-11-27.md:
 *
 * - B15: запрос с одним значимым словом («Сколько стоит MDaemon») не
 *   считался названием продукта;
 * - B16: смена продукта в диалоге игнорировалась — слоты «залипали»;
 * - B17: флаг `discovery` не снимался, и после «не знаю, что нужно» точный
 *   подбор по названию был недоступен;
 * - C9: `no-urls` ловил только ссылки со схемой;
 * - C12: значения слотов из базы использовались без проверки;
 * - C13: разбор слотов путал единицы («1 год» ≠ 12 месяцев, «10 тыс.»);
 * - C15: карточки позиций собирались по одной (N+1);
 * - C16: справочник вендоров перечитывался на каждый ход.
 */

const TENANT_SLUG = `audit-catalog-slots-${uniqueSuffix()}`;

let tenantId = "";
let conversationId = "";

/** Позиция каталога для проверки подбора. */
type ProductFixture = {
  offerId: string;
  name: string;
  vendor: string;
  price: number;
  quantity: number;
  term: string;
  delivery: string;
  categoryId: string;
};

const FIXTURES: ProductFixture[] = [
  {
    offerId: "9101",
    name: "MDaemon Security Gateway for Email Servers, 50 пользователей",
    vendor: "MDaemon Technologies",
    price: 17359,
    quantity: 50,
    term: "12 мес.",
    delivery: "Серверная",
    categoryId: "cat-net",
  },
  {
    offerId: "9102",
    name: "MDaemon Security Gateway for Email Servers, 100 пользователей",
    vendor: "MDaemon Technologies",
    price: 23145,
    quantity: 100,
    term: "12 мес.",
    delivery: "Серверная",
    categoryId: "cat-net",
  },
  {
    offerId: "9103",
    name: "Dr.Web Security Suite, 50 ПК",
    vendor: "Доктор Веб",
    price: 80818.4,
    quantity: 50,
    term: "12 мес.",
    delivery: "Клиентская",
    categoryId: "cat-av",
  },
  {
    // Срок позиции — в годах: без приведения к месяцам позиция не подходила
    // под запрос на 12 месяцев.
    offerId: "9104",
    name: "Аудит Срок Год Защита Почты, 50 пользователей",
    vendor: "Аудит Поставщик",
    price: 10000,
    quantity: 50,
    term: "1 год",
    delivery: "Серверная",
    categoryId: "cat-net",
  },
];

async function seedProducts(): Promise<void> {
  const pool = getPool();

  await pool.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]);
  await pool.query(
    "UPDATE catalog_snapshots SET is_current = false WHERE tenant_id = $1",
    [tenantId],
  );

  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO catalog_snapshots (tenant_id, source_url, feed_date, fetched_at, snapshot_hash, offers_count, categories_count, is_current, source_kind)
     VALUES ($1, 'https://store.softline.ru/feeds/Softline.yml.gz', now(), now(), $2, $3, 0, true, 'test')
     RETURNING id`,
    [tenantId, `hash-${uniqueSuffix()}`, FIXTURES.length],
  );
  const snapshotId = snapshot.rows[0]?.id ?? "";

  const categories: Array<{ id: string; path: string }> = [
    { id: "cat-net", path: "Антивирусы и безопасность / Интернет и Сеть" },
    { id: "cat-av", path: "Антивирусы и безопасность / Антивирусы для организаций" },
  ];
  for (const category of categories) {
    await pool.query(
      `INSERT INTO catalog_categories (tenant_id, category_id, name, path)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, category_id) DO UPDATE SET path = EXCLUDED.path`,
      [tenantId, category.id, category.path.split(" / ").at(-1) ?? category.path, category.path],
    );
  }

  for (const fixture of FIXTURES) {
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
          "Срок действия": fixture.term,
          "Способ доставки": fixture.delivery,
        }),
        snapshotId,
        fixture.categoryId,
      ],
    );
  }
}

const NO_SLOTS: RequirementSlots = {
  quantity: null,
  termMonths: null,
  deployment: null,
  vendor: null,
  budget: null,
  productQuery: null,
  discovery: null,
  domain: null,
};

/** Подмена `query` у пула: считает SQL-запросы по образцу. */
function countQueries(pool: { query: unknown }, pattern: RegExp): () => number {
  let counter = 0;
  const original = pool.query;
  pool.query = ((...args: unknown[]) => {
    const sql = String(args[0] ?? "");
    if (pattern.test(sql)) counter += 1;
    // Оригинал вызывается с тем же `this`, что и при обычном обращении:
    // метод пула держит состояние соединения, и вызов без контекста роняет
    // его на чтении `this.Promise`.
    return (original as (...rest: unknown[]) => unknown).apply(pool, args);
  }) as unknown;
  return () => counter;
}

describe("аудит каталога и слотов (BUGSAUDIT-2026-11-27)", () => {
  beforeAll(async () => {
    await ensureSchema();
    tenantId = await createTenant(TENANT_SLUG);
  });

  beforeEach(async () => {
    await seedProducts();
    const conversation = await getPool().query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id`,
      [tenantId],
    );
    conversationId = conversation.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await getPool().query(
      "DELETE FROM conversations WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)",
      [TENANT_SLUG],
    );
    await cleanupTenant(TENANT_SLUG);
    await closePool();
  });

  it("B15: «Сколько стоит MDaemon» — название продукта, а не пустой запрос", () => {
    // Регрессия: одно значимое слово считалось не названием, и запрос
    // «сколько стоит X» уходил в доменный подбор без результата.
    expect(extractProductQuery("Сколько стоит MDaemon")).toBe("mdaemon");
    expect(extractProductQuery("Нужен MDaemon")).toBe("mdaemon");
  });

  it("B15: «Сколько стоит MDaemon» находит продукт в каталоге", async () => {
    const result = await lookupCatalog("Сколько стоит MDaemon", NO_SLOTS, {
      tenantId,
      limit: 5,
    });

    expect(result.productQuery).toBe("mdaemon");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.name).toContain("MDaemon");
  });

  it("B17: названный продукт отменяет подбор по задаче", async () => {
    // Регрессия: после «не знаю, что нужно» подбор навсегда шёл по
    // предметной области, и точное название не находилось.
    const stale = { ...NO_SLOTS, discovery: "подбор" };
    const result = await lookupCatalog("Нужен MDaemon Security Gateway", stale, {
      tenantId,
      limit: 5,
    });

    expect(result.productQuery).toBe("mdaemon security gateway");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.name).toContain("MDaemon");
  });

  it("C9: ссылка без схемы убирается из текста ответа", () => {
    const text = "Карточка: softline.ru/product/123";
    const cleaned = stripUrls(text);

    expect(cleaned).not.toContain("softline.ru");
    expect(cleaned).not.toContain("/product/123");
    // Ссылка без схемы — тоже ссылка: правило ADR-0014 действует на любой
    // текст, а не только на подмножество со схемой.
    expect(containsUrl(text)).toBe(true);
  });

  it("C9: обычный текст без ссылок не меняется", () => {
    const text = "Лицензия на 120 минут, стоимость 5000 рублей.";
    expect(stripUrls(text)).toBe(text);
  });

  it("C12: неизвестный домен из базы игнорируется", async () => {
    await getPool().query(
      `INSERT INTO conversation_slots (conversation_id, slot, value, updated_at)
       VALUES ($1, 'domain', 'неизвестный', now())
       ON CONFLICT (conversation_id, slot) DO UPDATE SET value = EXCLUDED.value`,
      [conversationId],
    );

    const loaded = await loadSlots(conversationId);
    expect(loaded.domain).toBeNull();

    // Подбор не падает и не выключается молча.
    const result = await lookupCatalog("Нужен MDaemon Security Gateway", {
      ...loaded,
      domain: "неизвестный",
    }, { tenantId, limit: 5 });

    expect(result.domain).toBeNull();
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("C12: неизвестный домен в подборе по задаче не роняет каталог", async () => {
    const result = await lookupCatalog("нужен антивирус для почты", {
      ...NO_SLOTS,
      domain: "неизвестный",
    }, { tenantId, limit: 5 });

    expect(result.domain).toBe("email");
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("C12: неизвестное значение слота не превращается в число", async () => {
    await getPool().query(
      `INSERT INTO conversation_slots (conversation_id, slot, value, updated_at)
       VALUES ($1, 'quantity', 'много', now())
       ON CONFLICT (conversation_id, slot) DO UPDATE SET value = EXCLUDED.value`,
      [conversationId],
    );

    const loaded = await loadSlots(conversationId);
    expect(loaded.quantity).toBeNull();
  });

  it("C13: срок «1 год» — это 12 месяцев", () => {
    expect(extractSlots("на 1 год").termMonths).toBe(12);
    expect(extractSlots("на 12 месяцев, платим за год").termMonths).toBe(12);
  });

  it("C13: бюджет «10 тыс.» — это 10000", () => {
    expect(extractSlots("бюджет 10 тыс.").budget).toBe("10000");
    expect(extractSlots("бюджет 50 000 рублей").budget).toBe("50000");
    // Бюджет не путается с количеством лицензий.
    expect(extractSlots("бюджет 10 тыс.").quantity).toBeNull();
  });

  it("C13: позиция со сроком «1 год» подходит под запрос на 12 месяцев", async () => {
    const result = await lookupCatalog("Нужен Аудит Срок Год", {
      ...NO_SLOTS,
      quantity: 50,
      termMonths: 12,
      deployment: "сервер",
    }, { tenantId, limit: 5 });

    expect(result.matches.some((match) => match.offerId === "9104")).toBe(true);
    // Срок позиции закрыл слот: уточнять его не нужно.
    expect(result.missingSlots).not.toContain("termMonths");
  });

  it("C15: карточки позиций собираются одним запросом, а не по одной на позицию", async () => {
    const pools = [
      getPool() as unknown as { query: unknown },
      getCatalogPool() as unknown as { query: unknown },
    ];
    const batch = countQueries(pools[0]!, /p\.offer_id\s*=\s*ANY/iu);
    const single = countQueries(pools[1]!, /AND p\.offer_id\s*=\s*\$\d/iu);

    await lookupCatalog("Нужен MDaemon Security Gateway", NO_SLOTS, { tenantId, limit: 5 });

    expect(batch()).toBeGreaterThan(0);
    expect(single()).toBe(0);
  });

  it("C16: справочник вендоров не перечитывается на каждый ход", async () => {
    const pool = getPool() as unknown as { query: unknown };
    const original = pool.query;
    const vendorQueries = countQueries(pool, /SELECT DISTINCT vendor/iu);

    try {
      await lookupCatalog("Нужен MDaemon Security Gateway", NO_SLOTS, { tenantId, limit: 5 });
      const afterFirst = vendorQueries();
      await lookupCatalog("Нужен MDaemon Security Gateway", NO_SLOTS, { tenantId, limit: 5 });
      // Второй ход не перечитывает справочник вендоров.
      expect(vendorQueries()).toBe(afterFirst);
      expect(vendorQueries()).toBeLessThanOrEqual(1);
    } finally {
      pool.query = original;
    }
  });

  it("слоты сохраняются и читаются без потерь", async () => {
    await saveSlots(conversationId, { ...NO_SLOTS, quantity: 50 });
    const loaded = await loadSlots(conversationId);
    expect(loaded.quantity).toBe(50);
  });
});
