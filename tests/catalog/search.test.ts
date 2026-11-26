import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importFeed } from "@/import/catalog";
import { catalog } from "@/modules/catalog";
import { cleanupTenant, createTenant, ensureSchema, uniqueSuffix } from "./helpers/db";

// Фикстура каталога: три категории (одна вложена в другую), четыре позиции.
// Две позиции с пустым vendorCode не должны сливаться, одна — с нулевой ценой.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="2026-11-25 14:12">
<shop>
<name>store.softline.ru</name>
<currencies>
<currency id="RUR" rate="1"/>
</currencies>
<categories>
<category id="8">Программы для работы с текстом</category>
<category id="6" parentId="8">Программы для распознавания текста</category>
</categories>
<offers>
<offer id="504" available="true">
<name>Adobe InCopy CC Professional</name>
<vendor>Adobe Systems</vendor>
<vendorCode></vendorCode>
<url>https://store.softline.ru/adobe/504/</url>
<price>1200.00</price>
<currencyId>RUR</currencyId>
<categoryId>6</categoryId>
<delivery>true</delivery>
<pickup>false</pickup>
<description>Лицензия 12 мес.</description>
<param name="Срок действия">12 мес.</param>
<param name="Язык интерфейса">Русская версия</param>
</offer>
<offer id="505" available="true">
<name>ABBYY FineReader PDF</name>
<vendor>ABBYY</vendor>
<vendorCode></vendorCode>
<url>https://store.softline.ru/abbyy/505/</url>
<price>0.00</price>
<currencyId>RUR</currencyId>
<categoryId>8</categoryId>
<delivery>true</delivery>
<pickup>false</pickup>
<description>Цена не подтверждена заказчиком</description>
<param name="Срок действия">36 мес.</param>
</offer>
<offer id="506" available="false">
<name>ABBYY FineReader PDF Corporate</name>
<vendor>ABBYY</vendor>
<vendorCode></vendorCode>
<url>https://store.softline.ru/abbyy/506/</url>
<price>990.00</price>
<currencyId>RUR</currencyId>
<categoryId>8</categoryId>
<delivery>false</delivery>
<pickup>false</pickup>
<description>Корпоративная версия</description>
</offer>
<offer id="507" available="true">
<name>Сумматор документов</name>
<vendor>Софтлайн</vendor>
<vendorCode>SL-507</vendorCode>
<url>https://store.softline.ru/sl/507/</url>
<price>100.00</price>
<currencyId>RUR</currencyId>
<categoryId>6</categoryId>
<delivery>true</delivery>
<pickup>false</pickup>
<description>Внутренняя позиция</description>
<param name="Срок действия">12 мес.</param>
</offer>
</offers>
</shop>
</yml_catalog>
`;

describe("структурный поиск по каталогу", () => {
  let tenantId: string;
  let tenantSlug: string;
  let feedHash: string;

  beforeAll(async () => {
    await ensureSchema();
    tenantSlug = `catalog-search-${uniqueSuffix()}`;
    tenantId = await createTenant(tenantSlug);
    const dir = await mkdtemp(join(tmpdir(), "catalog-search-"));
    const feedPath = join(dir, "feed.xml");
    await writeFile(feedPath, FEED, "utf8");
    feedHash = createHash("sha256").update(FEED, "utf8").digest("hex");
    await importFeed(feedPath, { tenantId, sourceUrl: null });
  });

  afterAll(async () => {
    await cleanupTenant(tenantSlug);
  });

  it("находит позицию по точной части названия", async () => {
    const hits = await catalog.search("InCopy", { tenantId });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.offerId).toBe("504");
    expect(hits[0]?.name).toBe("Adobe InCopy CC Professional");
    expect(hits[0]?.vendor).toBe("Adobe Systems");
  });

  it("находит позицию по точному offer_id", async () => {
    const hits = await catalog.search("504", { tenantId });
    expect(hits.map((hit) => hit.offerId)).toContain("504");
  });

  it("фильтрует по вендору", async () => {
    const hits = await catalog.search("", { tenantId, vendor: "ABBYY" });
    expect(hits.map((hit) => hit.offerId).sort()).toEqual(["505", "506"]);
  });

  it("фильтр по категории включает подкатегории", async () => {
    // 505 и 506 лежат в категории 8, 504 и 507 — в подкатегории 6.
    const hits = await catalog.search("", { tenantId, categoryId: "8" });
    expect(hits.map((hit) => hit.offerId).sort()).toEqual(["504", "505", "506", "507"]);

    const direct = await catalog.search("", { tenantId, categoryId: "6" });
    expect(direct.map((hit) => hit.offerId).sort()).toEqual(["504", "507"]);
  });

  it("фильтрует по параметру по точному имени", async () => {
    const hits = await catalog.search("", { tenantId, params: { "Срок действия": "36 мес." } });
    expect(hits.map((hit) => hit.offerId)).toEqual(["505"]);
  });

  it("availableOnly исключает недоступные позиции", async () => {
    const hits = await catalog.search("", { tenantId, availableOnly: true });
    expect(hits.map((hit) => hit.offerId).sort()).toEqual(["504", "505", "507"]);
  });

  it("позиция с нулевой ценой возвращается с priceConfirmed=false", async () => {
    const hits = await catalog.search("", { tenantId, vendor: "ABBYY" });
    const unconfirmed = hits.find((hit) => hit.offerId === "505");
    expect(unconfirmed?.price).toBe(0);
    expect(unconfirmed?.priceConfirmed).toBe(false);
    const confirmed = hits.find((hit) => hit.offerId === "506");
    expect(confirmed?.priceConfirmed).toBe(true);
  });

  it("по отсутствующему запросу возвращает пустой список", async () => {
    const hits = await catalog.search("такого товара в каталоге нет", { tenantId });
    expect(hits).toEqual([]);
  });

  it("в карточке видны дата фида и хеш снимка", async () => {
    const hits = await catalog.search("InCopy", { tenantId });
    expect(hits[0]?.feedDate).toBe("2026-11-25T14:12:00.000Z");
    expect(hits[0]?.snapshotHash).toBe(feedHash);
    expect(hits[0]?.categoryPath).toBe(
      "Программы для работы с текстом / Программы для распознавания текста",
    );
  });

  it("две позиции с одинаковым пустым vendorCode не объединяются", async () => {
    const hits = await catalog.search("", { tenantId, vendor: "ABBYY" });
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((hit) => hit.offerId)).size).toBe(2);
  });

  it("getByOfferId возвращает карточку позиции", async () => {
    const item = await catalog.getByOfferId("504", { tenantId });
    expect(item?.offerId).toBe("504");
    expect(item?.price).toBe(1200);
    expect(item?.available).toBe(true);
    expect(item?.priceConfirmed).toBe(true);

    const missing = await catalog.getByOfferId("нет-такой", { tenantId });
    expect(missing).toBeNull();
  });
});
