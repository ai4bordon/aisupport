/**
 * Выпуск коммерческого предложения и счёта по позиции каталога (ADR-0019).
 *
 * Ответы заказчика от 27.11.2026 изменили порядок: если в каталоге есть
 * цена, агент формирует КП и выдаёт его клиенту сам, без предварительного
 * одобрения менеджера. Менеджер подтверждает фактическую поставку.
 *
 * Наличие по снимку фида условием выдачи не является: при `available=false`
 * документ формируется по цене и параметрам позиции, а наличие помечается
 * как неподтверждённый статус снимка.
 *
 * Суммы и НДС считает код (модуль `documents`), модель в расчёте не
 * участвует: текст клиенту собирает код из проверенных данных.
 */

import { renderQuote, defaultVatRate } from "@/modules/documents";
import type { QuoteInput, QuoteLine } from "@/modules/documents";
import type { CatalogMatch } from "@/core/catalog-lookup";

/** Позиция расчёта: код позиции, количество и цена из снимка фида. */
export type QuotePosition = {
  /** Код позиции в каталоге (`offer_id`). */
  offerId: string;
  /** Количество лицензий или единиц. */
  quantity: number;
};

/** Данные, которых достаточно для выпуска КП. */
export type QuoteRequest = {
  /** Тенант. */
  tenantId: string;
  /** Диалог, к которому относится документ. */
  conversationId: string;
  /** Наименование заказчика — из данных диалога. */
  customerName: string;
  /** Позиции расчёта. */
  positions: QuotePosition[];
  /** Найденные позиции каталога: цена и параметры берутся из них. */
  matches: CatalogMatch[];
  /** Дата формирования документа, `ДД.ММ.ГГГГ`. */
  date: string;
  /** Порядковый номер счётчика документов арендатора. */
  sequence: number;
};

/** Результат выпуска документа. */
export type IssuedDocument = {
  /** Вид документа. */
  kind: "quote";
  /** Номер документа. */
  number: string;
  /** Сумма документа в рублях. */
  amount: number;
  /** НДС в рублях. */
  vat: number;
  /** Путь к готовому PDF. */
  pdfPath: string;
  /** Текст, который видит клиент: без URL и без реквизитов. */
  clientText: string;
  /**
   * Позиции с пометкой о наличии.
   *
   * `available=false` не блокирует выпуск: клиент видит цену, а менеджер
   * получает пометку, что фактическую поставку подтвердить нужно ему.
   */
  availabilityNote: string | null;
};

/**
 * Срок поставки по умолчанию.
 *
 * Допущение A9: для электронной лицензии срок поставки — тот же рабочий
 * день. Значение помечается как снимок, а не как подтверждённая поставка.
 */
export const DEFAULT_DELIVERY_TERM =
  "в тот же рабочий день после оплаты (допущение для электронной лицензии)";

/** Срок действия КП: 14 календарных дней от даты формирования. */
export const QUOTE_VALID_DAYS = 14;

/**
 * Число дней до указанной даты.
 *
 * Разница в днях между двумя датами `ДД.ММ.ГГГГ`: срок действия КП считается
 * от даты формирования, а не от даты запроса.
 */
function addDays(date: string, days: number): string {
  const parts = date.split(".").map((part) => Number.parseInt(part, 10));
  const [day, month, year] = parts;
  if (
    day === undefined ||
    month === undefined ||
    year === undefined ||
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year)
  ) {
    return date;
  }
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(base.getUTCDate())}.${pad(base.getUTCMonth() + 1)}.${base.getUTCFullYear()}`;
}

/**
 * Ищет позицию каталога по её коду.
 *
 * Позиция расчёта и позиция каталога — разные вещи: клиент мог назвать
 * другое количество, чем указано в карточке, поэтому количество берётся
 * из расчёта, а цена и параметры — из карточки.
 */
function matchByOfferId(
  matches: CatalogMatch[],
  offerId: string,
): CatalogMatch | null {
  return matches.find((match) => match.offerId === offerId) ?? null;
}

/**
 * Формирует строки расчёта КП.
 *
 * Сумма строки считается кодом: цена из снимка фида, умноженная на
 * количество. Строки без найденной позиции пропускаются: цена, которой
 * нет в снимке, в документе быть не может.
 */
export function quoteLines(
  positions: QuotePosition[],
  matches: CatalogMatch[],
): QuoteLine[] {
  const lines: QuoteLine[] = [];
  for (const position of positions) {
    const match = matchByOfferId(matches, position.offerId);
    if (match === null) continue;
    const price = Math.round(match.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const amount = price * position.quantity;
    lines.push({
      offerId: position.offerId,
      name: match.name,
      quantity: position.quantity,
      price,
      amount,
      // НДС включён в цену: ставка применяется к сумме «с НДС», поэтому
      // выделяется из неё, а не прибавляется.
      vat: Math.round((amount * defaultVatRate) / (100 + defaultVatRate)),
    });
  }
  return lines;
}

/**
 * Текст о наличии для клиента и менеджера.
 *
 * Наличие по снимку фида — не подтверждение фактической поставки: при
 * `available=false` документ всё равно выпускается, а менеджеру остаётся
 * подтвердить поставку.
 */
export function availabilityNote(matches: CatalogMatch[]): string | null {
  if (matches.length === 0) return null;
  const unavailable = matches.filter((match) => !match.available);
  if (unavailable.length === 0) return null;
  return `Наличие по снимку фида не подтверждено для ${unavailable.length} из ${matches.length} позиций — подтверждение фактической поставки остаётся за менеджером.`;
}

/**
 * Формирует КП и текст для клиента.
 *
 * Проверка полей и расхождения сумм — внутри модуля документов: пустое
 * обязательное поле или расхождение блокируют выпуск, а не создают
 * документ с дырами.
 */
export async function issueQuote(request: QuoteRequest): Promise<IssuedDocument> {
  const lines = quoteLines(request.positions, request.matches);
  if (lines.length === 0) {
    throw new Error("Нет позиций с подтверждённой ценой — КП не формируется.");
  }

  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const vatTotal = lines.reduce((sum, line) => sum + line.vat, 0);

  const input: QuoteInput = {
    number: `Исх. № ${request.sequence} от ${request.date}`,
    date: request.date,
    customerName: request.customerName,
    lines,
    total,
    vatTotal,
    paymentTerms: "prepaid",
    deliveryTerm: DEFAULT_DELIVERY_TERM,
    validUntil: addDays(request.date, QUOTE_VALID_DAYS),
  };

  const rendered = await renderQuote(input);
  const note = availabilityNote(request.matches);

  // Клиенту — цена, состав позиций и условия, без ссылки на файл и без
  // указания, где лежит документ: ссылка на карточку остаётся в источниках
  // ответа, в трассе и в кабинете менеджера (ADR-0014).
  const clientLines = [
    "Коммерческое предложение сформировано по позициям каталога с ценами.",
    "",
    ...lines.map(
      (line, index) =>
        `${index + 1}. ${line.name} — ${line.quantity} шт. по ${line.price} ₽, итого ${line.amount} ₽.`,
    ),
    "",
    `Итого: ${total} ₽, в том числе НДС ${vatTotal} ₽.`,
    `Срок поставки: ${DEFAULT_DELIVERY_TERM}.`,
    `Срок действия КП — до ${input.validUntil}.`,
    "Цена указана с учётом всех налогов, сборов и других обязательных платежей.",
  ];
  if (note !== null) clientLines.push("", note);

  return {
    kind: "quote",
    number: rendered.number,
    amount: total,
    vat: vatTotal,
    pdfPath: rendered.pdfPath,
    clientText: clientLines.join("\n"),
    availabilityNote: note,
  };
}
