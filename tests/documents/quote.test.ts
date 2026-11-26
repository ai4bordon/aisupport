// @vitest-environment node
import { existsSync } from "node:fs";
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
  process.env.DOCUMENTS_DIR = await mkdtemp(join(tmpdir(), "aisupport-docs-quote-"));
});

/**
 * Синтетические входные данные: каталожная позиция и расчёт вымышлены,
 * настоящих цен фида заказчика в тесте нет.
 */
function quoteInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return {
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
    deliveryTerm: "В тот же рабочий день после оплаты (допущение для электронной лицензии)",
    validUntil: "26.12.2026",
    ...overrides,
  };
}

async function render(input: QuoteInput) {
  const rendered = await renderQuote(input);
  const raw = await readFile(rendered.pdfPath);
  return { rendered, parsed: parsePdf(raw), raw };
}

describe("КП по шаблону заказчика", () => {
  it("содержит наименование заказчика, исходящий номер и дату", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain("ООО «Ромашка»");
    expect(parsed.text).toContain("Исх. № бн от 26.11.2026");
    expect(parsed.text).toContain("26.11.2026");
  });

  it("содержит шапку ПАО «Софтлайн» с адресом и подтверждёнными реквизитами", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain("ПАО «Софтлайн»");
    expect(parsed.text).toContain("119021, город Москва, ул Льва Толстого, д. 5 стр. 1, этаж 3, помещ. 1, ком. №2, 2а (а-311)");
    expect(parsed.text).toContain("Т +7 495 232 00 23");
    expect(parsed.text).toContain("info@softline.com");
    expect(parsed.text).toContain("www.softline.ru");
  });

  it("обращается к заказчику по шаблону", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain("Уважаемый заказчик!");
    expect(parsed.text).toContain(
      "ПАО «Софтлайн» предлагает Вашему вниманию коммерческое предложение на следующих условиях:",
    );
  });

  it("печатает таблицу с колонками шаблона заказчика", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain("Артикул");
    expect(parsed.text).toContain("Наименование");
    expect(parsed.text).toContain("Кол-во");
    expect(parsed.text).toContain("Цена, руб.");
    expect(parsed.text).toContain("Сумма, руб.");
    expect(parsed.text).toContain("В т.ч. НДС, руб.");
  });

  it("печатает позиции расчёта кодом", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain("SYNTH-OFFER-001");
    expect(parsed.text).toContain("Синтетическая лицензия KES Standard, 1 устройство");
    expect(parsed.text).toContain("1 200");
    expect(parsed.text).toContain("60 000");
    expect(parsed.text).toContain("10 000");
  });

  it("печатает строку «Итого» с итогом и НДС из входного расчёта", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain("Итого");
    expect(parsed.text).toContain("60 000");
    expect(parsed.text).toContain("10 000");
  });

  it("печатает формулировку о цене с учётом налогов, условия оплаты, срок поставки и срок действия", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain(
      "Цена указана с учетом всех налогов, сборов, и других обязательных платежей.",
    );
    expect(parsed.text).toContain("Условия оплаты: Предоплата.");
    expect(parsed.text).toContain("Срок поставки: В тот же рабочий день после оплаты");
    expect(parsed.text).toContain("Срок действия коммерческого предложения - до 26.12.2026.");
  });

  it("печатает подписанта из шаблона", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).toContain("Бондаренко Александр");
    expect(parsed.text).toContain("Директор департамента");
  });

  it("не оставляет незаполненных плейсхолдеров", async () => {
    const { parsed } = await render(quoteInput());

    expect(parsed.text).not.toMatch(/\[[^\]]*\]/);
    expect(parsed.text).not.toContain("undefined");
    expect(parsed.text).not.toContain("null");
    expect(parsed.text).not.toContain("NaN");
  });

  it("не печатает реквизиты, пришедшие во входной структуре", async () => {
    const { parsed } = await render(
      quoteInput({
        customerName: "ООО «Ромашка»",
        lines: [
          {
            offerId: "SYNTH-OFFER-001",
            name: "Синтетическая лицензия",
            quantity: 1,
            price: 100,
            amount: 100,
            vat: 0,
          },
        ],
        total: 100,
        vatTotal: 0,
      }),
    );

    expect(parsed.text).not.toContain("ИНН");
    expect(parsed.text).not.toContain("БИК");
    expect(parsed.text).not.toContain("р/с");
  });
});

describe("Правила формирования КП", () => {
  it("блокирует документ при пустом обязательном поле", async () => {
    await expect(renderQuote(quoteInput({ customerName: "   " }))).rejects.toMatchObject({
      code: "document_field_missing",
      field: "customerName",
    });
  });

  it("блокирует документ без условий оплаты", async () => {
    await expect(
      renderQuote(quoteInput({ paymentTerms: "" as QuoteInput["paymentTerms"] })),
    ).rejects.toMatchObject({ code: "document_field_missing", field: "paymentTerms" });
  });

  it("блокирует документ без срока поставки", async () => {
    await expect(renderQuote(quoteInput({ deliveryTerm: "" }))).rejects.toMatchObject({
      code: "document_field_missing",
      field: "deliveryTerm",
    });
  });

  it("блокирует документ без срока действия", async () => {
    await expect(renderQuote(quoteInput({ validUntil: "" }))).rejects.toMatchObject({
      code: "document_field_missing",
      field: "validUntil",
    });
  });

  it("блокирует документ при расхождении итога с входным расчётом", async () => {
    await expect(renderQuote(quoteInput({ total: 59999 }))).rejects.toMatchObject({
      code: "amount_mismatch",
    });
  });

  it("блокирует документ при расхождении НДС с входным расчётом", async () => {
    await expect(renderQuote(quoteInput({ vatTotal: 9999 }))).rejects.toMatchObject({
      code: "amount_mismatch",
    });
  });

  it("не создаёт файл документа при ошибке", async () => {
    const error = await renderQuote(quoteInput({ total: 1 })).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "amount_mismatch" });
    const detail = error as { pdfPath?: string };
    expect(detail.pdfPath).toBeUndefined();
    expect(existsSync(String(detail.pdfPath))).toBe(false);
  });

  it("возвращает номер документа, сумму и путь к файлу", async () => {
    const { rendered } = await render(quoteInput());

    expect(rendered.kind).toBe("quote");
    expect(rendered.number).toBeTruthy();
    expect(rendered.amount).toBe(60000);
    expect(rendered.pdfPath).toMatch(/\.pdf$/);
  });
});
