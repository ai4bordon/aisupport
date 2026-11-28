import { describe, it, expect } from "vitest";

import { chunkSource, selectIndexableChunks } from "@/import/knowledge";

const LONG_SENTENCE = "Тестовое предложение для проверки нарезки на чанки заданного размера.";

function makeText(sentences: number, length = 120): string {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i += 1) {
    parts.push(`${LONG_SENTENCE.slice(0, 20)} номер ${i}. ${"я".repeat(Math.max(0, length - 30))}`);
  }
  return parts.join(" ");
}

describe("chunkSource", () => {
  it("делит текст на чанки по 800–1200 знаков", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "Как войти в аккаунт",
      sectionPath: "Softline ID / Авторизация",
      text: makeText(40),
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(800);
      expect(chunk.text.length).toBeLessThanOrEqual(1200);
    }
  });

  it("сохраняет в каждом чанке заголовок, путь разделов и URL источника", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "Как войти в аккаунт",
      sectionPath: "Softline ID / Авторизация",
      text: makeText(10),
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.title).toBe("Как войти в аккаунт");
      expect(chunk.sectionPath).toBe("Softline ID / Авторизация");
      expect(chunk.sourceUrl).toBe("https://docs.softline.com/ru-ru/id/login");
      // URL обязан быть в самом тексте чанка: цитата строится из выдачи поиска.
      expect(chunk.text).toContain("https://docs.softline.com/ru-ru/id/login");
    }
  });

  it("короткий текст даёт один чанк", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/about",
      title: "О сервисе",
      sectionPath: "Softline ID",
      text: "Короткая статья.",
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("Короткая статья.");
  });

  it("границы не разрывают предложение без необходимости", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "Как войти в аккаунт",
      sectionPath: "Softline ID / Авторизация",
      text: makeText(30),
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      // Последний знак законченного предложения — точка, вопрос или многоточие.
      expect(chunk.text.trimEnd().endsWith(".")).toBe(true);
    }
  });

  it("chunkNo и totalChunks согласованы", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "Как войти в аккаунт",
      sectionPath: "Softline ID / Авторизация",
      text: makeText(25),
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(chunks.length).toBeGreaterThan(1);
    const total = chunks.length;
    chunks.forEach((chunk, index) => {
      expect(chunk.chunkNo).toBe(index);
      expect(chunk.totalChunks).toBe(total);
    });
  });

  it("один идентификатор статьи на все чанки источника", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "Как войти в аккаунт",
      sectionPath: "Softline ID / Авторизация",
      text: makeText(15),
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    const ids = new Set(chunks.map((chunk) => chunk.articleId));
    expect(ids.size).toBe(1);
  });

  it("одинаковый URL даёт одинаковый идентификатор, разный — разный", () => {
    const first = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "A",
      sectionPath: "",
      text: "Текст.",
      crawledAt: "2026-11-26T10:00:00.000Z",
    });
    const second = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "A",
      sectionPath: "",
      text: "Другой текст.",
      crawledAt: "2026-11-26T10:00:00.000Z",
    });
    const third = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/logout",
      title: "A",
      sectionPath: "",
      text: "Текст.",
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(first[0]?.articleId).toBe(second[0]?.articleId);
    expect(first[0]?.articleId).not.toBe(third[0]?.articleId);
  });

  it("длинный текст не даёт чанков длиннее верхней границы", () => {
    // Страницы заказчика встречаются с разной длиной текста: хвост
    // страницы не должен вылезать за 1200 знаков.
    for (const sentences of [3, 7, 13, 40, 97]) {
      const chunks = chunkSource({
        url: `https://docs.softline.com/ru-ru/id/page-${sentences}`,
        title: "Заголовок страницы",
        sectionPath: "Softline ID / Раздел",
        text: makeText(sentences),
        crawledAt: "2026-11-26T10:00:00.000Z",
      });

      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(1200);
      }
    }
  });

  it("пустой текст не даёт пустых чанков", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/empty",
      title: "Пусто",
      sectionPath: "",
      text: "",
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("selectIndexableChunks", () => {
  /**
   * Текст статьи «Оплата подписки» со стенда: 161 знак.
   *
   * Статья опубликована, но была отброшена при импорте: чанк короче
   * минимального размера, и материал целиком не попал в индекс. Вопрос
   * «Как оплатить подписку?» не находил источника и уходил в эскалацию.
   */
  const PAYMENT_BODY =
    "Оплата подписки производится автоматически по данным платёжного метода. " +
    "Подписка с автоматическим продлением (AR) требует согласия покупателя. " +
    "Отмена продления доступна в личном кабинете Softline Checkout.";

  it("короткий материал со смыслом попадает в индекс хотя бы одним чанком", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/payments/subscription-payment",
      title: "Оплата подписки",
      sectionPath: "Платежные методы",
      text: PAYMENT_BODY,
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    // Текст короче минимального чанка: нарезка даёт один чанк.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text.length).toBeLessThan(800);

    // Но материал содержательный, значит он индексируется.
    const usable = selectIndexableChunks(chunks);
    expect(usable).toHaveLength(1);
    expect(usable[0]?.text).toContain("Оплата подписки производится автоматически");
  });

  it("длинный материал индексируется целиком", () => {
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/id/login",
      title: "Как войти в аккаунт",
      sectionPath: "Softline ID / Авторизация",
      text: makeText(40),
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(selectIndexableChunks(chunks)).toHaveLength(chunks.length);
  });

  it("материал без содержательного текста в индекс не попадает", () => {
    // Страница-оглавление: цитировать нечего.
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/payments",
      title: "Платежные методы",
      sectionPath: "",
      text: "Оплата",
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(selectIndexableChunks(chunks)).toEqual([]);
  });

  it("длинный заголовок не выдаёт материал без текста за содержательный", () => {
    // Шапка чанка — две строки: адрес источника и заголовок. Если разбирать
    // только первую строку, заголовок попадал бы в тело, и материал без
    // текста проходил бы проверку длины за счёт своего заголовка.
    const longTitle =
      "Способы оплаты счетов в панели управления клиентом: оплата с баланса, банковским переводом и картой";
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/subscriptions/payment",
      title: longTitle,
      sectionPath: "Softline Подписки / Оплата подписки",
      text: "",
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    // Заголовок длиннее порога, но содержательного текста за ним нет.
    expect(longTitle.length).toBeGreaterThan(40);
    expect(selectIndexableChunks(chunks)).toEqual([]);
  });

  it("тело длиной ровно в порог попадает в индекс", () => {
    const body = "я".repeat(40);
    const chunks = chunkSource({
      url: "https://docs.softline.com/ru-ru/subscriptions/payment",
      title: "Оплата подписки",
      sectionPath: "Softline Подписки / Оплата подписки",
      text: body,
      crawledAt: "2026-11-26T10:00:00.000Z",
    });

    expect(selectIndexableChunks(chunks)).toHaveLength(1);
  });

  it("пустой список чанков не даёт ошибку", () => {
    expect(selectIndexableChunks([])).toEqual([]);
  });
});
