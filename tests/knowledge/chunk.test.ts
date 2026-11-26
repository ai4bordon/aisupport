import { describe, it, expect } from "vitest";

import { chunkSource } from "@/import/knowledge";

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
});
