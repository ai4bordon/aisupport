// @vitest-environment node
/**
 * Выпуск КП по позиции каталога (ADR-0019).
 *
 * Ответы заказчика от 27.11.2026: при наличии цены в каталоге агент
 * формирует КП и выдаёт клиенту сам, без одобрения менеджера; наличие по
 * снимку фида условием выдачи не является.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_DELIVERY_TERM,
  availabilityNote,
  issueQuote,
  quoteLines,
} from "@/modules/quote-issuance";
import type { CatalogMatch } from "@/core/catalog-lookup";

/** Позиция каталога для теста: цена и наличие заданы явно. */
function match(
  offerId: string,
  price: number,
  available: boolean,
  name = `Позиция ${offerId}`,
): CatalogMatch {
  return {
    offerId,
    name,
    vendor: "Вендор",
    edition: null,
    price,
    currency: "RUR",
    available,
    priceConfirmed: true,
    feedDate: "2026-11-25",
    snapshotHash: "hash",
    url: `https://store.softline.ru/item/${offerId}`,
    params: {},
    item: {
      offerId,
      name,
      vendor: "Вендор",
      price,
      currencyId: "RUR",
      available,
      priceConfirmed: true,
      feedDate: "2026-11-25",
      snapshotHash: "hash",
      productUrl: `https://store.softline.ru/item/${offerId}`,
      params: {},
    } as CatalogMatch["item"],
  };
}

beforeAll(async () => {
  process.env.DOCUMENTS_DIR = await mkdtemp(join(tmpdir(), "quote-issuance-"));
});

describe("выпуск КП: строки расчёта", () => {
  it("сумма строки считается кодом по цене из снимка фида", () => {
    const lines = quoteLines([{ offerId: "1", quantity: 50 }], [match("1", 1200, true)]);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.price).toBe(1200);
    expect(lines[0]?.amount).toBe(60000);
    expect(lines[0]?.vat).toBe(10000);
  });

  it("позиция без найденной карточки в расчёт не попадает", () => {
    const lines = quoteLines([{ offerId: "нет-такой" }], [match("1", 1200, true)]);

    expect(lines).toHaveLength(0);
  });

  it("позиция без подтверждённой цены в расчёт не попадает", () => {
    const lines = quoteLines([{ offerId: "1", quantity: 1 }], [match("1", 0, true)]);

    expect(lines).toHaveLength(0);
  });
});

describe("выпуск КП: наличие по снимку фида", () => {
  it("для позиций в наличии пометки нет", () => {
    expect(availabilityNote([match("1", 1200, true)])).toBeNull();
  });

  it("при available=false документ всё равно выпускается, но помечается", async () => {
    const issued = await issueQuote({
      tenantId: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000002",
      customerName: 'ООО «Ромашка»',
      positions: [{ offerId: "1", quantity: 50 }],
      matches: [match("1", 1200, false)],
      date: "27.11.2026",
      sequence: 1,
    });

    expect(issued.kind).toBe("quote");
    expect(issued.amount).toBe(60000);
    expect(issued.availabilityNote).not.toBeNull();
    expect(issued.clientText).toContain("подтверждение фактической поставки");
  });

  it("текст клиенту содержит цену, итог и срок поставки", async () => {
    const issued = await issueQuote({
      tenantId: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000003",
      customerName: 'ООО «Ромашка»',
      positions: [{ offerId: "1", quantity: 50 }],
      matches: [match("1", 1200, true)],
      date: "27.11.2026",
      sequence: 2,
    });

    expect(issued.clientText).toContain("1200");
    expect(issued.clientText).toContain("60000");
    expect(issued.clientText).toContain(DEFAULT_DELIVERY_TERM);
  });

  it("текст клиенту не содержит URL и пути к файлу", async () => {
    const issued = await issueQuote({
      tenantId: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000004",
      customerName: 'ООО «Ромашка»',
      positions: [{ offerId: "1", quantity: 1 }],
      matches: [match("1", 1200, true)],
      date: "27.11.2026",
      sequence: 3,
    });

    expect(issued.clientText).not.toContain("http");
    expect(issued.clientText).not.toContain(issued.pdfPath);
  });

  it("срок действия КП — 14 дней от даты формирования", async () => {
    const issued = await issueQuote({
      tenantId: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000005",
      customerName: 'ООО «Ромашка»',
      positions: [{ offerId: "1", quantity: 1 }],
      matches: [match("1", 1200, true)],
      date: "27.11.2026",
      sequence: 4,
    });

    expect(issued.clientText).toContain("11.12.2026");
  });
});

describe("выпуск КП: без позиций с ценой", () => {
  it("КП не выпускается", async () => {
    await expect(
      issueQuote({
        tenantId: "00000000-0000-0000-0000-000000000001",
        conversationId: "00000000-0000-0000-0000-000000000006",
        customerName: 'ООО «Ромашка»',
        positions: [{ offerId: "нет-такой", quantity: 1 }],
        matches: [match("1", 1200, true)],
        date: "27.11.2026",
        sequence: 5,
      }),
    ).rejects.toThrow(/подтверждённой ценой/);
  });
});
