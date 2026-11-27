import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { detectDomain } from "@/core/catalog-domain";
import {
  extractProductQuery,
  extractSlots,
  lookupCatalog,
  parseProductName,
  type RequirementSlots,
} from "@/core/catalog-lookup";
import { loadSlots, saveSlots } from "@/core/slots";
import { closePool } from "@/db/pool";
import { cleanupTenant, createTenant, ensureSchema, uniqueSuffix } from "../catalog/helpers/db";

/**
 * Сценарии заказчика R1a/R1b (ADR-0015):
 *
 * - клиент знает продукт: агент находит его в каталоге и показывает цену из
 *   снимка фида;
 * - клиент знает продукт, но не указал количество: агент задаёт уточняющий
 *   вопрос;
 * - клиент не знает продукт: агент подбирает позиции по описанию задачи.
 *
 * Каталог заполняется напрямую: тест проверяет поведение ядра и подбора, а
 * не разбор фида.
 */

const TENANT_SLUG = `test-catalog-lookup-${uniqueSuffix()}`;

let tenantId = "";
let conversationId = "";

/** Позиция каталога с параметрами лицензии. */
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

async function seedProducts(): Promise<void> {
  const { getPool } = await import("@/db/pool");
  const pool = getPool();

  // Позиции предыдущего теста удаляются: `offer_id` уникален в пределах
  // арендатора, а тесты делят одну фикстуру.
  await pool.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]);

  const fixtures: ProductFixture[] = [
    {
      offerId: "9001",
      name: "MDaemon Security Gateway for Email Servers, 50 пользователей",
      vendor: "MDaemon Technologies",
      price: 17359,
      quantity: 50,
      term: "12 мес.",
      delivery: "Серверная",
      categoryId: "cat-net",
    },
    {
      offerId: "9002",
      name: "MDaemon Security Gateway for Email Servers, 100 пользователей",
      vendor: "MDaemon Technologies",
      price: 23145,
      quantity: 100,
      term: "12 мес.",
      delivery: "Серверная",
      categoryId: "cat-net",
    },
    {
      offerId: "9003",
      name: "Dr.Web Security Suite, 50 ПК",
      vendor: "Доктор Веб",
      price: 80818.4,
      quantity: 50,
      term: "12 мес.",
      delivery: "Клиентская",
      categoryId: "cat-av",
    },
    {
      offerId: "9004",
      name: "Почтовый сервер Tegu Enterprise, 500 пользователей",
      vendor: "Лаборатория МБК",
      price: 662400,
      quantity: 500,
      term: "12 мес.",
      delivery: "Серверная",
      categoryId: "cat-net",
    },
    {
      offerId: "9005",
      name: "POS-аксессуар Защитный чехол с ремнем на плечо",
      vendor: "iDPRT",
      price: 953,
      quantity: 1,
      term: "12 мес.",
      delivery: "Электронный",
      categoryId: "cat-gizmo",
    },
  ];

  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO catalog_snapshots (tenant_id, source_url, feed_date, fetched_at, snapshot_hash, offers_count, categories_count, is_current, source_kind)
     VALUES ($1, 'https://store.softline.ru/feeds/Softline.yml.gz', now(), now(), $2, $3, 0, true, 'test')
     RETURNING id`,
    [tenantId, `hash-${uniqueSuffix()}`, fixtures.length],
  );
  const snapshotId = snapshot.rows[0]?.id ?? "";

  // Категории нужны для отбора по домену: подбор идёт по категориям фида, а
  // не по словам названия. Форма — как в фиде: категория «Интернет и Сеть»
  // для почтовой безопасности, «Антивирусы для организаций» для Dr.Web.
  const categories: Array<{ id: string; path: string }> = [
    { id: "cat-net", path: "Антивирусы и безопасность / Интернет и Сеть" },
    { id: "cat-av", path: "Антивирусы и безопасность / Антивирусы для организаций" },
    { id: "cat-gizmo", path: "Торговое оборудование / POS-аксессуары" },
  ];
  for (const category of categories) {
    await pool.query(
      `INSERT INTO catalog_categories (tenant_id, category_id, name, path)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, category_id) DO UPDATE SET path = EXCLUDED.path`,
      [tenantId, category.id, category.path.split(" / ").at(-1) ?? category.path, category.path],
    );
  }

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
          // Форма фида: количество и срок — диапазоны, а не числа.
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

describe("подбор по каталогу (R1a/R1b)", () => {
  beforeAll(async () => {
    await ensureSchema();
    tenantId = await createTenant(TENANT_SLUG);
  });

  beforeEach(async () => {
    await seedProducts();
    const { getPool } = await import("@/db/pool");
    const conversation = await getPool().query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id`,
      [tenantId],
    );
    conversationId = conversation.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    // Диалоги удаляются до арендатора: на него ссылаются `conversations`.
    const { getPool } = await import("@/db/pool");
    await getPool().query(
      "DELETE FROM conversations WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)",
      [TENANT_SLUG],
    );
    await cleanupTenant(TENANT_SLUG);
    await closePool();
  });

  it("название продукта извлекается из сообщения", () => {
    expect(extractProductQuery("Нужен MDaemon Standard")).toBe("mdaemon standard");
    expect(extractProductQuery("Сколько стоит Dr.Web Security")).toBe("dr web security");
  });

  it("вопрос без названия продукта не даёт запроса к каталогу", () => {
    expect(extractProductQuery("Сколько стоит?")).toBeNull();
    expect(extractProductQuery("Подскажите, пожалуйста")).toBeNull();
  });

  it("клиент знает продукт: находятся позиции с ценой из снимка фида", async () => {
    const slots = { ...NO_SLOTS, quantity: 50, termMonths: 12, deployment: "сервер" };
    const result = await lookupCatalog("Нужен MDaemon Security Gateway", slots, {
      tenantId,
      limit: 5,
    });

    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches[0];
    expect(match?.name).toContain("MDaemon");
    expect(match?.price).toBeGreaterThan(0);
    expect(match?.url).toContain("store.softline.ru");
  });

  it("клиент знает продукт, но не указал количество: задаётся уточняющий вопрос", async () => {
    const result = await lookupCatalog("Нужен MDaemon Security Gateway", NO_SLOTS, {
      tenantId,
      limit: 5,
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.missingSlots).toContain("quantity");
  });

  it("клиент не знает продукт: подбираются позиции по описанию задачи", async () => {
    const result = await lookupCatalog("защита почты для 50 сотрудников", {
      ...NO_SLOTS,
      quantity: 50,
    }, { tenantId, limit: 5 });

    expect(result.matches.length).toBeGreaterThan(0);
    // Подбор должен находить разные позиции, а не одну и ту же.
    expect(new Set(result.matches.map((match) => match.offerId)).size).toBe(
      result.matches.length,
    );
  });

  it("слоты накапливаются по диалогу", async () => {
    await saveSlots(conversationId, { ...NO_SLOTS, quantity: 50 });
    await saveSlots(conversationId, { ...NO_SLOTS, termMonths: 12 });

    const loaded = await loadSlots(conversationId);
    expect(loaded.quantity).toBe(50);
    expect(loaded.termMonths).toBe(12);
    expect(loaded.deployment).toBeNull();
  });

  it("количество и срок извлекаются из текста", () => {
    const slots = extractSlots("нужно 50 лицензий на 12 месяцев в облаке");
    expect(slots.quantity).toBe(50);
    expect(slots.termMonths).toBe(12);
    expect(slots.deployment).toBe("облако");
  });

  it("срок не путается с количеством", () => {
    // Регрессия: «12 месяцев» считалось количеством 12, и подбор уходил не
    // туда.
    const slots = extractSlots("На 12 месяцев, развёртываем на сервере");
    expect(slots.quantity).toBeNull();
    expect(slots.termMonths).toBe(12);
    expect(slots.deployment).toBe("сервер");
  });

  it("ответ на уточняющий вопрос не подменяет название продукта", async () => {
    // Регрессия: ответ на вопрос о сроке («на 12 месяцев, развёртываем на
    // сервере») подменял сохранённое название продукта своим текстом, и
    // поиск уходил не туда. Название берётся из сохранённого слота.
    const saved = { ...NO_SLOTS, productQuery: "mdaemon security gateway" };
    const result = await lookupCatalog("На 12 месяцев, развёртываем на сервере", saved, {
      tenantId,
      limit: 5,
    });

    expect(result.productQuery).toBe("mdaemon security gateway");
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("название продукта не извлекается, когда клиент говорит, что не знает продукт", () => {
    // Регрессия: «не знаю, что нужно» превращалось в название продукта, и
    // поиск по словам находил «Защитный чехол с ремнем на плечо».
    expect(extractProductQuery("Не знаю, что нужно, но хотим защитить почту")).toBeNull();
    expect(extractProductQuery("Подскажите, что выбрать")).toBeNull();
    expect(extractProductQuery("Помогите подобрать продукт")).toBeNull();
  });

  it("определяется предметная область задачи", () => {
    expect(detectDomain("хотим защитить почту на 50 сотрудников")).toBe("email");
    expect(detectDomain("нужен антивирус")).toBe("security");
    expect(detectDomain("привет")).toBeNull();
  });

  it("«инфраструктура своя» и «бюджета нет» распознаются", () => {
    // Регрессия: слоты не распознавались, и агент повторял один и тот же
    // вопрос про срок.
    const slots = extractSlots("Бюджета нет, инфраструктура своя");
    expect(slots.budget).toBe("нет");
    expect(slots.deployment).toBe("сервер");
    expect(slots.termMonths).toBeNull();
  });

  it("название позиции разбирается на название, редакцию и количество", () => {
    // Регрессия: в ответе читалось «Netwin SurgeMail , 50 пользователей» и
    // «Dr.Web …, лицензия на 1 год» — хвосты фида висели в имени, а
    // количество дублировалось ещё и в отдельном поле.
    const netwin = parseProductName(
      "Netwin Ltd. Netwin SurgeMail (лицензия + Anti Virus + Spam + Mirror), 50 пользователей",
      "Netwin Ltd.",
    );
    expect(netwin.name).toBe("Netwin SurgeMail");
    expect(netwin.edition).toBe("лицензия + Anti Virus + Spam + Mirror");
    expect(netwin.quantityText).toBe("50");

    const drweb = parseProductName(
      "Доктор Веб Dr.Web Gateway Security Suite, Антивирус + Центр Управления лицензия на 1 год на 1 год на 50 ПК",
      "Доктор Веб",
    );
    expect(drweb.name).toBe("Dr.Web Gateway Security Suite, Антивирус + Центр Управления лицензия");
    expect(drweb.edition).toBe("на 1 год");
    expect(drweb.quantityText).toBe("50");
  });

  it("подбор по задаче не возвращает позиции вне домена", async () => {
    // Регрессия: на «защитить почту» выдавались «Проектирование дорожных
    // знаков» и «Защитный чехол с ремнем на плечо» — всё, где встречается
    // слово «защит».
    const result = await lookupCatalog(
      "Не знаю, что нужно, но хотим защитить почту на 50 сотрудников",
      { ...NO_SLOTS, quantity: 50 },
      { tenantId, limit: 10 },
    );

    expect(result.domain).toBe("email");
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      const text = `${match.name} ${JSON.stringify(match.params)}`.toLowerCase();
      expect(text.includes("чехол"), `«${match.name}» — не почтовая защита`).toBe(false);
      expect(text.includes("дорожн"), `«${match.name}» — не почтовая защита`).toBe(false);
    }
  });
});
