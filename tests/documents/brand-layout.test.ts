// @vitest-environment node
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { renderQuote } from "@/modules/documents";
import type { QuoteInput } from "@/modules/documents";
import { parsePdf } from "./pdf-inspect";

beforeAll(async () => {
  // Свой каталог на файл теста: тесты идут параллельно в форках, общий
  // каталог приводит к гонке за один и тот же PDF.
  process.env.DOCUMENTS_DIR = await mkdtemp(join(tmpdir(), "aisupport-docs-brand-"));
});

/**
 * Оформление корпоративного бланка по ADR-0012 и R26.
 *
 * Проверки идут по собранному PDF: логотип, реквизиты, слоган, шрифт,
 * палитра и геометрия охранного поля.
 */

const quoteInput = (): QuoteInput => ({
  number: "Исх. № бн от 26.11.2026",
  date: "26.11.2026",
  customerName: "ООО «Ромашка»",
  lines: [
    {
      offerId: "SYNTH-OFFER-001",
      name: "Синтетическая лицензия KES Standard, 1 устройство",
      quantity: 50,
      price: 1200,
      amount: 60000,
      vat: 10000,
    },
  ],
  total: 60000,
  vatTotal: 10000,
  paymentTerms: "prepaid",
  deliveryTerm: "В тот же рабочий день после оплаты (допущение)",
  validUntil: "26.12.2026",
});

async function render() {
  const rendered = await renderQuote(quoteInput());
  const raw = await readFile(rendered.pdfPath);
  return parsePdf(raw);
}

/** Печатная палитра ADR-0012 §2.1–2.2 в долях RGB. */
const palette = {
  bordeaux: { r: 162 / 255, g: 12 / 255, b: 51 / 255 },
  gray: { r: 166 / 255, g: 168 / 255, b: 171 / 255 },
  blue: { r: 35 / 255, g: 150 / 255, b: 211 / 255 },
  graphite: { r: 104 / 255, g: 105 / 255, b: 104 / 255 },
  black: { r: 0, g: 0, b: 0 },
};

function hasColor(
  colors: Array<{ r: number; g: number; b: number }>,
  expected: { r: number; g: number; b: number },
): boolean {
  return colors.some(
    (color) =>
      Math.abs(color.r - expected.r) < 0.01 &&
      Math.abs(color.g - expected.g) < 0.01 &&
      Math.abs(color.b - expected.b) < 0.01,
  );
}

describe("Корпоративный бланк по ADR-0012 и R26", () => {
  it("встраивает официальный логотип «Софтлайн Решения + SOFL»", async () => {
    const parsed = await render();

    // Логотип — цветная версия 2000×442 из пакета заказчика.
    const logo = parsed.images.find((image) => image.width === 2000 && image.height === 442);
    expect(logo).toBeDefined();
  });

  it("не деформирует и не поворачивает логотип", async () => {
    const parsed = await render();

    expect(parsed.placements.length).toBeGreaterThan(0);
    for (const placement of parsed.placements) {
      // Матрица размещения не содержит поворота или сдвига по диагонали.
      expect(placement.scaleX).not.toBe(0);
      expect(placement.scaleY).not.toBe(0);

      // Пропорции логотипа (2000×442) сохраняются: масштаб по осям
      // пропорционален, поворот отсутствует.
      const aspect = Math.abs(placement.scaleX / placement.scaleY);
      expect(aspect).toBeCloseTo(2000 / 442, 2);
    }
  });

  it("оставляет вокруг логотипа охранное поле не меньше его высоты", async () => {
    const parsed = await render();

    const placement = parsed.placements[0];
    expect(placement).toBeDefined();
    const logoWidth = Math.abs(placement?.scaleX ?? 0);
    const logoHeight = Math.abs(placement?.scaleY ?? 0);
    const logoRight = (placement?.x ?? 0) + logoWidth;

    // Полоса шапки, занятая логотипом: в PDF текст и картинка считаются от
    // верхнего края страницы, поэтому полоса логотипа задаётся его
    // координатой и высотой.
    const logoBottom = placement?.y ?? 0;
    const logoTop = logoBottom - logoHeight;

    // Ни один элемент не заходит в охранное поле логотипа: текст рядом с
    // логотипом начинается не ближе, чем его высота справа от края.
    const nearLogo = parsed.runs
      .filter((run) => Number.isFinite(run.y))
      .map((run) => ({
        x: run.x,
        fromTop: parsed.pageHeight - run.y,
      }))
      .filter((run) => run.fromTop >= logoTop - 2 && run.fromTop <= logoBottom + 2)
      .filter((run) => run.x > logoRight);

    expect(nearLogo.length).toBeGreaterThan(0);
    expect(Math.min(...nearLogo.map((run) => run.x)) - logoRight).toBeGreaterThanOrEqual(
      logoHeight - 0.01,
    );
  });

  it("печатает подтверждённые реквизиты ПАО «Софтлайн» в шапке", async () => {
    const parsed = await render();

    expect(parsed.text).toContain("ПАО «Софтлайн»");
    expect(parsed.text).toContain("119021, город Москва, ул Льва Толстого");
    expect(parsed.text).toContain("info@softline.com");
    expect(parsed.text).toContain("www.softline.ru");
  });

  it("печатает слоган «Мы знаем. Мы можем.» в подвале", async () => {
    const parsed = await render();

    expect(parsed.text).toContain("Мы знаем. Мы можем.");
  });

  it("набирает документ шрифтом Montserrat", async () => {
    const parsed = await render();

    expect(parsed.fonts.length).toBeGreaterThan(0);
    for (const font of parsed.fonts) {
      expect(font.baseFont).toContain("Montserrat");
    }
  });

  it("печатает основной текст бланка чёрным", async () => {
    const parsed = await render();

    const bodyRuns = parsed.runs.filter((run) => run.text.trim().length > 0);
    expect(bodyRuns.length).toBeGreaterThan(0);
    for (const run of bodyRuns) {
      expect(run.color).toEqual(palette.black);
    }
  });

  it("использует печатную палитру Softline", async () => {
    const parsed = await render();

    expect(hasColor(parsed.colors, palette.bordeaux)).toBe(true);
    expect(hasColor(parsed.colors, palette.gray)).toBe(true);
    expect(hasColor(parsed.colors, palette.graphite)).toBe(true);
  });

  it("не содержит цветов вне печатной палитры Softline", async () => {
    const parsed = await render();
    const allowed = [palette.bordeaux, palette.gray, palette.blue, palette.graphite, palette.black];

    for (const color of parsed.colors) {
      const known = allowed.some(
        (candidate) =>
          Math.abs(color.r - candidate.r) < 0.01 &&
          Math.abs(color.g - candidate.g) < 0.01 &&
          Math.abs(color.b - candidate.b) < 0.01,
      );
      expect(known).toBe(true);
    }
  });
});
