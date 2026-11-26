/**
 * Формирование счёта по собственному шаблону команды (R3).
 *
 * Шаблон счёта заказчик не передавал, поэтому счёт собирается на том же
 * корпоративном бланке, но со своими блоками: реквизиты получателя из
 * тестовой конфигурации, назначение платежа, срок оплаты. Реквизиты
 * подставляет код — модель их не печатает.
 */

import { join } from "node:path";

import type { InvoiceInput, RenderedDocument } from "./types";
import type { LineValues, TemplateValues } from "./render";
import {
  DocumentError,
  assertAmountMatches,
  assertRequiredFields,
  documentsDirectory,
  renderDocument,
} from "./render";
import {
  companyDetails,
  invoiceRequiredFields,
  invoiceRecipient,
  invoiceTemplate,
} from "./templates";
import { calculateQuoteAmounts, documentDatePart, formatMoney } from "./quote";

/** Ставка НДС по умолчанию для синтетических демо-позиций (R2, R3). */
export const defaultInvoiceVatRate = 20;

/** Значения позиций для подстановки в таблицу счёта. */
export function invoiceLineValues(input: InvoiceInput): LineValues[] {
  const vatRate = input.vatRate ?? defaultInvoiceVatRate;
  return input.lines.map((line) => ({
    offerId: line.offerId,
    name: line.name,
    quantity: String(line.quantity),
    price: formatMoney(line.price),
    amount: formatMoney(line.amount),
    vat: formatMoney(
      input.vatRate === undefined ? line.vat : Math.round((line.amount * vatRate) / (100 + vatRate)),
    ),
  }));
}

/**
 * Номер счёта формирует код: дата и порядковый номер. Номер уникален в
 * пределах тенанта (docs/data-model.md §3.17).
 */
export function buildInvoiceNumber(date: string, sequence: number): string {
  return `СЧ-${documentDatePart(date)}-${String(sequence).padStart(3, "0")}`;
}

/**
 * Формирует черновик счёта.
 *
 * Пустое обязательное поле блокирует документ `document_field_missing`,
 * расхождение итога с входным расчётом — `amount_mismatch`. В обоих случаях
 * файл не создаётся.
 */
export async function renderInvoice(input: InvoiceInput): Promise<RenderedDocument> {
  const number = buildInvoiceNumber(input.date, 1);

  const values: TemplateValues = {
    customerName: input.customerName,
    number,
    date: input.date,
    recipientName: invoiceRecipient.name,
    recipientInn: invoiceRecipient.inn,
    goodsDescription: input.goodsDescription,
    paymentPurpose: input.paymentPurpose,
    paymentDue: input.paymentDue,
    total: input.total,
    vatTotal: input.vatTotal,
    currency: "руб.",
    companyLegalName: companyDetails.legalName,
  };

  assertRequiredFields(values, invoiceRequiredFields);

  if (input.lines.length === 0) {
    throw new DocumentError(
      "document_field_missing",
      "lines",
      "обязательное поле документа не заполнено: lines",
    );
  }

  const calculated = calculateQuoteAmounts({
    number,
    date: input.date,
    customerName: input.customerName,
    lines: input.lines,
    total: input.total,
    vatTotal: input.vatTotal,
    paymentTerms: "prepaid",
    deliveryTerm: "",
    validUntil: "",
    ...(input.vatRate === undefined ? {} : { vatRate: input.vatRate }),
  });
  assertAmountMatches(calculated, { total: input.total, vatTotal: input.vatTotal });

  const finalValues: TemplateValues = {
    ...values,
    total: formatMoney(input.total),
    vatTotal: formatMoney(input.vatTotal),
  };

  const lines = invoiceLineValues(input);
  const blocks = invoiceTemplate.map((block) => {
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

  const outputPath = join(documentsDirectory(), "invoice", `${number}.pdf`);

  return renderDocument({
    kind: "invoice",
    number,
    amount: input.total,
    values: finalValues,
    blocks,
    outputPath,
  });
}
