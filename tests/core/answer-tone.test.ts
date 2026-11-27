/**
 * Тон ответов клиенту (решение владельца от 27.11.2026).
 *
 * Клиент не должен видеть, как устроена система изнутри: ни источников, ни
 * базы знаний, ни каталога, ни фида. При эскалации клиент получает одну
 * фразу без причин и подробностей.
 */

import { describe, expect, it } from "vitest";

import { catalogAnswer, catalogMatchText } from "@/core/catalog-lookup";
import { noSourceAnswer } from "@/core/escalation-mode";
import { stripSourceMarkers } from "@/core/no-urls";
import { DEFAULT_SYSTEM_PROMPT } from "@/core/system-prompt";

/** Внутренние термины, которых не должно быть в тексте клиенту. */
const INTERNAL_TERMS = [
  /источник/i,
  /база знаний/i,
  /опубликован/i,
  /каталог/i,
  /\bфид\b/i,
  /Источник:\s*\[\d+\]/,
];

/** Позиция каталога для проверки текста. */
function match() {
  return {
    offerId: "1",
    name: "Security Gateway for Email Servers",
    vendor: "MDaemon Technologies, Ltd.",
    edition: null,
    price: 34717,
    currency: "RUR",
    available: true,
    priceConfirmed: true,
    feedDate: "2026-11-27T02:27:00.000Z",
    snapshotHash: "hash",
    url: "https://store.softline.ru/item/1",
    params: {},
    item: {
      offerId: "1",
      name: "Security Gateway for Email Servers",
      vendor: "MDaemon Technologies, Ltd.",
      price: 34717,
      currencyId: "RUR",
      available: true,
      priceConfirmed: true,
      feedDate: "2026-11-27T02:27:00.000Z",
      snapshotHash: "hash",
      productUrl: "https://store.softline.ru/item/1",
      params: {},
    } as never,
  };
}

describe("текст ответа клиенту без внутренних терминов", () => {
  it("ответ по карточке не упоминает внутренние термины", () => {
    const text = catalogAnswer([match()], "mdaemon security gateway");

    for (const term of INTERNAL_TERMS) {
      expect(text, `в ответе есть «${term}»`).not.toMatch(term);
    }
  });

  it("текст позиции для цитирования не упоминает внутренние термины", () => {
    const text = catalogMatchText(match());

    for (const term of INTERNAL_TERMS) {
      expect(text, `в тексте позиции есть «${term}»`).not.toMatch(term);
    }
  });

  it("ответ об отсутствии точных данных не упоминает внутренние термины", () => {
    const text = noSourceAnswer();

    for (const term of INTERNAL_TERMS) {
      expect(text, `в ответе есть «${term}»`).not.toMatch(term);
    }
  });

  it("служебные маркеры источников вычищаются из текста", () => {
    const text = [
      "Электронная лицензия приходит автоматически после оплаты.",
      "1. Откройте заказ.",
      "Источник: [1]",
    ].join("\n");

    const cleaned = stripSourceMarkers(text);

    expect(cleaned).not.toMatch(/Источник/i);
    expect(cleaned).toContain("Откройте заказ.");
  });

  it("фраза про источники в середине текста вычищается", () => {
    const cleaned = stripSourceMarkers(
      "В источниках нет данных по вашему запросу на 12 месяцев.",
    );

    expect(cleaned).not.toMatch(/источник/i);
  });

  it("фраза про переданные материалы вычищается", () => {
    const cleaned = stripSourceMarkers(
      "Точного ответа у меня пока нет: как активировать лицензию, в переданных материалах не описано.",
    );

    expect(cleaned).not.toMatch(/материал/i);
    expect(cleaned).not.toMatch(/данных/i);
  });
});

describe("системный промпт", () => {
  it("запрещает упоминать источники и внутренние термины", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Не упоминай внутренние термины");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("живым языком");
  });

  it("не требует добавлять ссылку на источник в конец ответа", () => {
    // Ссылка на источник в тексте клиенту недопустима, значит и требование
    // «в конце — ссылка на источник» из промпта убрано.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("В конце — ссылка на источник");
  });
});
