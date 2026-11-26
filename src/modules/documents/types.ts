/**
 * Типы порта «документы» (docs/api-contract.md §0.3) и входные структуры
 * модуля. Формы документов согласуются с контрактом; дополнительные поля
 * помечены как расширения и остаются необязательными.
 */

/** Позиция расчёта. Все денежные значения — целые рубли. */
export type QuoteLine = {
  offerId: string;
  name: string;
  quantity: number;
  price: number;
  amount: number;
  vat: number;
};

/**
 * Вход КП (контракт §0.3).
 *
 * `vatRate` — расширение среза: ставка синтетического налогового правила в
 * процентах. Когда задана, код считает НДС позиции сам и сверяет с `vat`;
 * когда не задана, код складывает переданные `vat` позиций.
 */
export type QuoteInput = {
  number: string;
  date: string;
  customerName: string;
  lines: QuoteLine[];
  total: number;
  vatTotal: number;
  paymentTerms: "prepaid" | "postpaid";
  deliveryTerm: string;
  validUntil: string;
  vatRate?: number;
};

/**
 * Вход счёта. Счёт формируется по собственному шаблону команды, поэтому
 * вход содержит привязку к обращению и назначение платежа, а реквизиты
 * получателя подставляет код из тестовой конфигурации.
 */
export type InvoiceInput = {
  tenantId: string;
  conversationId: string;
  customerName: string;
  date: string;
  lines: QuoteLine[];
  total: number;
  vatTotal: number;
  goodsDescription: string;
  paymentPurpose: string;
  paymentDue: string;
  vatRate?: number;
};

/** Готовый документ (контракт §0.3). */
export type RenderedDocument = {
  kind: "quote" | "invoice";
  number: string;
  pdfPath: string;
  amount: number;
};

/** Коды ошибок модуля документов. */
export type DocumentErrorCode = "document_field_missing" | "amount_mismatch";
