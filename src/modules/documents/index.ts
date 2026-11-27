/**
 * Публичный API модуля «документы» (docs/api-contract.md §0.2).
 *
 * Наружу срез отдаёт только формирование КП и счёта: остальное — внутреннее
 * дело модуля.
 */

export { renderQuote, defaultVatRate } from "./quote";
export { renderInvoice } from "./invoice";
export { DocumentError } from "./render";

export type {
  DocumentErrorCode,
  InvoiceInput,
  QuoteInput,
  QuoteLine,
  RenderedDocument,
} from "./types";
