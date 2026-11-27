// @vitest-environment node
/**
 * КП уходит клиенту без одобрения менеджера (ADR-0019, ответы заказчика
 * от 27.11.2026).
 *
 * Поведение, которое проверяет этот файл:
 *
 * 1. При наличии цены в каталоге КП формируется и выдаётся клиенту само по
 *    себе: одобрение менеджера не требуется и не запрашивается.
 * 2. Наличие по снимку фида условием выдачи не является: при
 *    `available=false` документ всё равно выпускается, а менеджеру остаётся
 *    подтвердить фактическую поставку.
 *
 * Модуль выпуска КП попал в ветку аудита вместе с базовой веткой, поэтому
 * поведение QA закреплено здесь отдельным файлом: тесты среза не должны
 * зависеть от того, чей коммит принёс модуль.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { issueQuote } from "@/modules/quote-issuance";
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
  process.env.DOCUMENTS_DIR = await mkdtemp(join(tmpdir(), "audit-quote-issuance-"));
});

describe("QA: КП уходит клиенту без одобрения менеджера", () => {
  it("КП выдаётся клиенту по цене из каталога без подтверждения менеджера", async () => {
    const issued = await issueQuote({
      tenantId: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000002",
      customerName: 'ООО «Ромашка»',
      positions: [{ offerId: "1", quantity: 50 }],
      matches: [match("1", 1200, true)],
      date: "27.11.2026",
      sequence: 1,
    });

    // Документ выпущен и клиенту есть что показать.
    expect(issued.kind).toBe("quote");
    expect(issued.amount).toBe(60000);
    expect(issued.clientText).toContain("1200 ₽");
    expect(issued.clientText).toContain("60000 ₽");
    expect(existsSync(issued.pdfPath)).toBe(true);

    // Подтверждения менеджера в выпуске нет: ни отдельного шага, ни
    // упоминания одобрения в тексте для клиента.
    expect(issued.clientText).not.toContain("одобрение менеджера");
    expect(issued.clientText).not.toContain("ожидает одобрения");
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

    expect(issued.clientText).toContain("в тот же рабочий день");
    expect(issued.clientText).toContain("Срок действия КП");
    // Ссылка на файл клиенту не отдаётся: она остаётся в источниках
    // ответа, в трассе и в кабинете менеджера.
    expect(issued.clientText).not.toContain(issued.pdfPath);
    expect(issued.clientText).not.toContain("http");
  });

  it("при available=false документ выпускается с пометкой о неподтверждённом наличии", async () => {
    const issued = await issueQuote({
      tenantId: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000004",
      customerName: 'ООО «Ромашка»',
      positions: [{ offerId: "1", quantity: 50 }],
      matches: [match("1", 1200, false)],
      date: "27.11.2026",
      sequence: 3,
    });

    // Наличие по снимку фида не блокирует выпуск.
    expect(issued.kind).toBe("quote");
    expect(issued.amount).toBe(60000);
    expect(existsSync(issued.pdfPath)).toBe(true);

    // Подтверждение фактической поставки остаётся за менеджером.
    expect(issued.availabilityNote).not.toBeNull();
    expect(issued.availabilityNote).toContain("подтверждение фактической поставки");
    expect(issued.clientText).toContain("подтверждение фактической поставки");
  });

  it("при подтверждённом наличии пометки о поставке нет", async () => {
    const issued = await issueQuote({
      tenantId: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000005",
      customerName: 'ООО «Ромашка»',
      positions: [{ offerId: "1", quantity: 50 }],
      matches: [match("1", 1200, true)],
      date: "27.11.2026",
      sequence: 4,
    });

    expect(issued.availabilityNote).toBeNull();
    expect(issued.clientText).not.toContain("подтверждение фактической поставки");
  });

  it("без цены в каталоге КП не выпускается", async () => {
    await expect(
      issueQuote({
        tenantId: "00000000-0000-0000-0000-000000000001",
        conversationId: "00000000-0000-0000-0000-000000000006",
        customerName: 'ООО «Ромашка»',
        positions: [{ offerId: "1", quantity: 50 }],
        matches: [match("1", 0, true)],
        date: "27.11.2026",
        sequence: 5,
      }),
    ).rejects.toThrow();
  });
});
