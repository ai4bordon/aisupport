/**
 * Формирование КП по шаблону заказчика (R2).
 *
 * Код собирает номер документа, считает суммы и НДС, подставляет значения в
 * шаблон и отдаёт готовый PDF. Реквизиты подставляет код — модель их не
 * печатает (docs/api-contract.md §7.2).
 */

import { join } from "node:path";

import type { QuoteInput, RenderedDocument } from "./types";
import type { LineValues, TemplateValues } from "./render";
import {
  DocumentError,
  assertAmountMatches,
  assertRequiredFields,
  documentsDirectory,
  renderDocument,
} from "./render";
import { companyDetails, quoteRequiredFields, quoteTemplate } from "./templates";

/** Формат денежных сумм: целые рубли, разряды через пробел. */
export function formatMoney(value: number): string {
  return Math.round(value)
    .toLocaleString("ru-RU", { useGrouping: true })
    .replace(/[  ]/g, " ");
}

/** Ставка НДС по умолчанию для синтетических демо-позиций (R2). */
export const defaultVatRate = 20;

/**
 * Считает НДС позиции кодом. Синтетическое налоговое правило: НДС уже
 * включён в цену с учётом налогов, поэтому он не прибавляется повторно
 * (docs/api-contract.md §7, R2).
 */
export function calculateLineVat(line: { amount: number }, vatRate: number): number {
  if (vatRate <= 0) return 0;
  return Math.round((line.amount * vatRate) / (100 + vatRate));
}

/** Суммы документа считает код. */
export type QuoteAmounts = {
  total: number;
  vatTotal: number;
};

export function calculateQuoteAmounts(input: QuoteInput): QuoteAmounts {
  const vatRate = input.vatRate ?? defaultVatRate;
  const total = input.lines.reduce((sum, line) => sum + line.amount, 0);
  const vatTotal =
    input.vatRate === undefined
      ? input.lines.reduce((sum, line) => sum + line.vat, 0)
      : input.lines.reduce((sum, line) => sum + calculateLineVat(line, vatRate), 0);
  return { total, vatTotal };
}

/** Значения позиций для подстановки в таблицу КП. */
export function quoteLineValues(input: QuoteInput): LineValues[] {
  const vatRate = input.vatRate ?? defaultVatRate;
  return input.lines.map((line) => ({
    offerId: line.offerId,
    name: line.name,
    quantity: String(line.quantity),
    price: formatMoney(line.price),
    amount: formatMoney(line.amount),
    vat: formatMoney(input.vatRate === undefined ? line.vat : calculateLineVat(line, vatRate)),
  }));
}

/** Текст условий оплаты из кода: модель выбирает только вид оплаты. */
export function paymentTermsText(terms: QuoteInput["paymentTerms"]): string {
  if (terms === "prepaid") return "Предоплата";
  if (terms === "postpaid") return "Постоплата";
  return "";
}

/**
 * Номер документа формирует код: дата и счётчик. Номер уникален в пределах
 * тенанта (docs/data-model.md §3.17).
 */
export function buildQuoteNumber(date: string, sequence: number): string {
  const compact = date.replace(/[^0-9]/g, "").slice(0, 8) || "00000000";
  return `КП-${compact}-${String(sequence).padStart(3, "0")}`;
}

/**
 * Формирует черновик КП по шаблону заказчика.
 *
 * Пустое обязательное поле блокирует документ `document_field_missing`,
 * расхождение итога с входным расчётом — `amount_mismatch`. В обоих случаях
 * файл не создаётся.
 */
export async function renderQuote(input: QuoteInput): Promise<RenderedDocument> {
  const values: TemplateValues = {
    customerName: input.customerName,
    number: input.number,
    date: input.date,
    companyLegalName: companyDetails.legalName,
    paymentTerms: paymentTermsText(input.paymentTerms),
    deliveryTerm: input.deliveryTerm,
    validUntil: input.validUntil,
    total: input.total,
    vatTotal: input.vatTotal,
    currency: "руб.",
  };

  assertRequiredFields(values, quoteRequiredFields);

  if (input.lines.length === 0) {
    throw new DocumentError(
      "document_field_missing",
      "lines",
      "обязательное поле документа не заполнено: lines",
    );
  }

  const calculated = calculateQuoteAmounts(input);
  assertAmountMatches(calculated, { total: input.total, vatTotal: input.vatTotal });

  const finalValues: TemplateValues = {
    ...values,
    total: formatMoney(input.total),
    vatTotal: formatMoney(input.vatTotal),
  };

  const lines = quoteLineValues(input);
  const blocks = quoteTemplate.map((block) => {
    if (block.kind !== "table") return block;
    const totalRow = block.rows[block.rows.length - 1];
    return {
      ...block,
      rows: [
        ...lines.map((line) => ({
          kind: "item" as const,
          cells: {
            offerId: line.offerId,
            name: line.name,
            quantity: line.quantity,
            price: line.price,
            amount: line.amount,
            vat: line.vat,
          },
        })),
        ...(totalRow ? [totalRow] : []),
      ],
    };
  });

  const outputPath = join(
    documentsDirectory(),
    "quote",
    `${input.number.replace(/[^0-9A-Za-zА-Яа-яЁё_-]+/g, "-")}.pdf`,
  );

  return renderDocument({
    kind: "quote",
    number: input.number,
    amount: input.total,
    values: finalValues,
    blocks,
    outputPath,
  });
}
