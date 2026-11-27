import { describe, expect, it } from "vitest";

import {
  AGENT_PROFILE,
  CLASSIFIER_PROMPT,
  INTENT_CLASSES,
  normalizeIntent,
  ROUTE_BY_CLASS,
} from "@/core/intents";
import { stripUrls } from "@/core/no-urls";

/**
 * Таксономия намерений, маршрутизация и правило «без ссылок в чате».
 */

describe("таксономия намерений", () => {
  it("классы образуют закрытый список", () => {
    expect(INTENT_CLASSES).toEqual([
      "greeting",
      "self_info",
      "company_info",
      "howto",
      "complaint",
      "product_known",
      "product_unknown",
      "quote",
      "terms",
      "out_of_scope",
    ]);
  });

  it("маршруты классов не смешиваются", () => {
    // Профиль агента: без поиска по базе знаний.
    expect(ROUTE_BY_CLASS.greeting).toBe("profile");
    expect(ROUTE_BY_CLASS.self_info).toBe("profile");
    // База знаний: ответ по чанкам.
    expect(ROUTE_BY_CLASS.company_info).toBe("knowledge");
    expect(ROUTE_BY_CLASS.howto).toBe("knowledge");
    expect(ROUTE_BY_CLASS.complaint).toBe("knowledge");
    // Каталог: слоты, расчёт кодом, полномочия.
    expect(ROUTE_BY_CLASS.product_known).toBe("catalog");
    expect(ROUTE_BY_CLASS.product_unknown).toBe("catalog");
    expect(ROUTE_BY_CLASS.quote).toBe("catalog");
    expect(ROUTE_BY_CLASS.terms).toBe("catalog");
  });

  it("ответ классификатора приводится к коду класса", () => {
    expect(normalizeIntent("product_known")).toBe("product_known");
    expect(normalizeIntent("  PRODUCT_UNKNOWN  ")).toBe("product_unknown");
    expect(normalizeIntent("Класс: howto")).toBe("howto");
    expect(normalizeIntent("'greeting'")).toBe("greeting");
  });

  it("неизвестный ответ трактуется как out_of_scope", () => {
    // Сомневаться надо в сторону осторожной ветки.
    expect(normalizeIntent("что-то неизвестное")).toBe("out_of_scope");
    expect(normalizeIntent("")).toBe("out_of_scope");
  });

  it("промпт содержит пример на каждый класс и запрет свободного текста", () => {
    for (const intent of INTENT_CLASSES) {
      expect(CLASSIFIER_PROMPT, `нет примера для ${intent}`).toContain(intent);
    }
    expect(CLASSIFIER_PROMPT).toContain("out_of_scope");
    expect(CLASSIFIER_PROMPT.toLowerCase()).toContain("строго");
  });

  it("профиль агента отвечает на вопрос о возможностях", () => {
    expect(AGENT_PROFILE).toContain("Софтлайн");
    expect(AGENT_PROFILE).toContain("умею");
    expect(AGENT_PROFILE).toContain("не делаю");
  });
});

describe("ссылки в клиентском чате", () => {
  it("голый URL удаляется из текста", () => {
    const text = "Подробности на https://docs.softline.com/ru-ru/id/password";
    expect(stripUrls(text)).not.toContain("http");
    expect(stripUrls(text)).not.toContain("https");
  });

  it("markdown-ссылка заменяется своим текстом", () => {
    const text = "См. [восстановление пароля](https://docs.softline.com/ru-ru/id/password)";
    const cleaned = stripUrls(text);
    expect(cleaned).toContain("восстановление пароля");
    expect(cleaned).not.toContain("http");
  });

  it("ссылка на карточку магазина тоже удаляется", () => {
    const text = "Карточка: https://store.softline.ru/adobe/504/";
    expect(stripUrls(text)).not.toContain("store.softline.ru");
  });

  it("текст без ссылок не меняется", () => {
    const text = "Лицензия на 120 минут, стоимость 5000 рублей.";
    expect(stripUrls(text)).toBe(text);
  });
});
