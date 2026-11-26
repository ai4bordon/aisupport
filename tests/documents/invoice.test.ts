// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { renderInvoice } from "@/modules/documents";
import type { InvoiceInput } from "@/modules/documents";
import { parsePdf } from "./pdf-inspect";

beforeAll(async () => {
  // Свой каталог на файл теста: тесты идут параллельно в форках, общий
  // каталог приводит к гонке за один и тот же PDF.
  process.env.DOCUMENTS_DIR = await mkdtemp(join(tmpdir(), "aisupport-docs-invoice-"));
});

/**
 * Синтетические входные данные: позиция и расчёт вымышлены, настоящих цен
 * фида заказчика в тесте нет.
 */
function invoiceInput(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    customerName: "ООО «Ромашка»",
    date: "26.11.2026",
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
    goodsDescription: "лицензии на программное обеспечение",
    paymentPurpose: "Оплата по счёту за лицензии по договору поставки",
    paymentDue: "5 рабочих дней с момента выставления счёта",
    ...overrides,
  };
}

async function render(input: InvoiceInput) {
  const rendered = await renderInvoice(input);
  const raw = await readFile(rendered.pdfPath);
  return { rendered, parsed: parsePdf(raw) };
}

describe("Счёт по собственному шаблону команды", () => {
  it("не использует шаблон КП и печатает номер счёта и дату", async () => {
    const { rendered, parsed } = await render(invoiceInput());

    expect(rendered.kind).toBe("invoice");
    expect(parsed.text).toMatch(/Счёт № СЧ-\d{8}-001/);
    expect(parsed.text).toContain("26.11.2026");
    expect(parsed.text).not.toContain("коммерческое предложение");
    expect(parsed.text).not.toContain("Срок действия коммерческого предложения");
  });

  it("печатает реквизиты получателя, подставленные кодом", async () => {
    const { parsed } = await render(invoiceInput());

    expect(parsed.text).toContain("Получатель:");
    expect(parsed.text).toContain("ИНН получателя:");
  });

  it("печатает сумму и НДС из входного расчёта", async () => {
    const { parsed } = await render(invoiceInput());

    expect(parsed.text).toContain("Итого");
    expect(parsed.text).toContain("60 000");
    expect(parsed.text).toContain("В том числе НДС 10 000 руб.");
  });

  it("печатает назначение платежа и срок оплаты", async () => {
    const { parsed } = await render(invoiceInput());

    expect(parsed.text).toContain(
      "Назначение платежа: Оплата по счёту за лицензии по договору поставки.",
    );
    expect(parsed.text).toContain("Срок оплаты: 5 рабочих дней с момента выставления счёта.");
  });

  it("печатает позиции расчёта и подписанта", async () => {
    const { parsed } = await render(invoiceInput());

    expect(parsed.text).toContain("SYNTH-OFFER-001");
    expect(parsed.text).toContain("Директор департамента");
  });

  it("не оставляет незаполненных плейсхолдеров", async () => {
    const { parsed } = await render(invoiceInput());

    expect(parsed.text).not.toMatch(/\{\{|\}\}/);
    expect(parsed.text).not.toContain("undefined");
    expect(parsed.text).not.toContain("NaN");
  });

  it("возвращает номер, сумму и путь к файлу", async () => {
    const { rendered } = await render(invoiceInput());

    expect(rendered.number).toMatch(/^СЧ-\d{8}-\d{3}$/);
    expect(rendered.amount).toBe(60000);
    expect(rendered.pdfPath).toMatch(/\.pdf$/);
    expect(existsSync(rendered.pdfPath)).toBe(true);
  });

  it("генерирует номер счёта кодом", async () => {
    const first = await render(invoiceInput());
    const second = await render(invoiceInput());

    expect(first.rendered.number).toBe(second.rendered.number);
    expect(first.rendered.number).toContain("20261126");
  });

  it("блокирует документ при пустом обязательном поле", async () => {
    await expect(renderInvoice(invoiceInput({ customerName: "" }))).rejects.toMatchObject({
      code: "document_field_missing",
      field: "customerName",
    });
  });

  it("блокирует документ без назначения платежа", async () => {
    await expect(renderInvoice(invoiceInput({ paymentPurpose: " " }))).rejects.toMatchObject({
      code: "document_field_missing",
      field: "paymentPurpose",
    });
  });

  it("блокирует документ при расхождении итога с входным расчётом", async () => {
    await expect(renderInvoice(invoiceInput({ total: 1 }))).rejects.toMatchObject({
      code: "amount_mismatch",
    });
  });

  it("не создаёт файл документа при ошибке", async () => {
    const error = await renderInvoice(invoiceInput({ total: 1 })).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "amount_mismatch" });
    const detail = error as { pdfPath?: string };
    expect(detail.pdfPath).toBeUndefined();
  });
});
