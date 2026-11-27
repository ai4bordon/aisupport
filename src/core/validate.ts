import type { Source } from "@/contracts/chat";
import { findRawPersonalDataValues } from "@/core/mask";

/**
 * Валидатор ответов агента.
 *
 * Инварианты (docs/api-contract.md §12):
 * - сумма, не найденная среди источников, блокирует ответ;
 * - цитата, отсутствующая в источнике, блокирует ответ;
 * - отсутствие подтверждённого источника — эскалация, а не пустой ответ;
 * - сырые ПД в исходящем тексте блокируют отправку.
 *
 * Суммы считает только код: валидатор сверяет числа, названные в ответе, с
 * числами источников — сам он ничего не вычисляет.
 *
 * Проверяется текст ответа, а не самоотчёт модели (аудит B4): модель могла
 * вернуть `amounts: []`, а в тексте написать «итого 9999 ₽» — и такой ответ
 * ушёл бы клиенту. Поле `amounts` остаётся дополнительным сигналом: сумма,
 * заявленная моделью, проверяется наравне с суммой, названной в тексте.
 */

export type CandidateAnswer = {
  text: string;
  amounts: number[];
  citations: string[];
};

export type ValidationViolation = {
  code: string;
  detail: string;
};

export type ValidationResult = {
  valid: boolean;
  violations: ValidationViolation[];
};

/** Нормализация текста для сравнения: пробелы и регистр. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Разделитель разрядов: обычный, неразрывный или тонкий пробел.
 *
 * «5 000», «5 000» и «5000» — одно число.
 */
const GROUP = "[ \\u00a0\\u202f]";

/**
 * Число текста.
 *
 * Первая альтернатива — число с разделителями разрядов, вторая — число без
 * них. Дробная часть учитывается у обоих: «999.50» и «999,50» — одно число
 * 999.
 */
const NUMBER = `\\d{1,3}(?:${GROUP}\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?`;

/**
 * Служебные фрагменты текста: их числа суммами не являются.
 *
 * Ссылка, метка персональных данных, ссылка на источник, номер документа и
 * дата — служебные значения: сравнивать их с суммами источника бессмысленно,
 * а ложное нарушение блокировало бы корректный ответ.
 */
const SERVICE_PATTERNS: RegExp[] = [
  // Адрес ссылки: «https://example.com/123».
  /https?:\/\/[^\s<>()[\]"'«»]+/giu,
  // Метка персональных данных: ⟦PERSON_1⟧.
  /⟦[A-Z]+_\d+⟧/gu,
  // Ссылка на источник в ответе: «[1]».
  /\[\d+\]/gu,
  // Номер документа: «№ 12345».
  /№\s*\d+/gu,
  // Дата: «12.03.2026», «2026-03-12».
  /\b\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}\b/gu,
];

/**
 * Слова перед числом, которые делают его порядковым номером.
 *
 * «п. 3», «стр. 5», «версия 2» — номера, а не суммы.
 */
const ORDINAL_BEFORE =
  /(?:№|п\.|стр\.|вер\.|гл\.|раздел\w*|шаг\w*|этап\w*|пункт\w*|верси\w*|том\w*)\s*$/iu;

/**
 * Денежные слова: около них число читается как сумма.
 *
 * Список узкий: «стоимость», «цена», «сумма», «итого», «оплата»,
 * «перечисление», «начисление», «чек», «счёт», «прайс», «тариф»,
 * «платёж», «взнос», «возврат», «аванс», «долг», «скидка», «переплата»,
 * «доплата», «рассрочка», «кредит», «субсидия».
 */
const MONEY_WORD =
  /(?:стоимост|цен[аыоеу]|сумм|итог|оплат|перечисл|начисл|внесен|взнос|чек|сч[её]т|прайс|тариф|плат[её]ж|возврат|аванс|долг|задолженност|переплат|доплат|скидк|рассрочк|кредит|субсиди)/iu;

/**
 * Валюта после числа: «5000 ₽», «5 000 рублей», «50 тыс. рублей».
 *
 * Разряд вынесен в группу: «50 тыс. рублей» — это 50000, а не 50.
 */
const CURRENCY_AFTER =
  /^(?:(?<magnitude>тыс\.?|тысяч\w*|млн\.?|миллион\w*)\s+)?(?:₽|руб\w*|(?<![\p{L}])р\.?|\b(?:RUB|USD|EUR)\b|\$|€)/iu;

/**
 * Процент после числа: «5%», «5 %», «10 процентов» — не сумма.
 *
 * Пробел между числом и знаком допустим: «скидка 3 %» — тот же процент,
 * а не сумма в три рубля.
 */
const PERCENT_AFTER = /^\s*(?:%|процент\w*)/iu;

/**
 * Все целые числа текста.
 *
 * Числа источника и числа ответа разбираются одной функцией: иначе
 * сравнение шло бы по разным правилам и «5 000» не совпало бы с «5000».
 */
function extractNumbers(text: string): Set<number> {
  const numbers = new Set<number>();
  for (const match of text.matchAll(new RegExp(NUMBER, "gu"))) {
    const integerPart = match[0].split(/[.,]/u)[0] ?? "";
    const digits = integerPart.replace(/[^\d]/gu, "");
    if (digits.length === 0) continue;
    numbers.add(Number(digits));
  }
  return numbers;
}

/**
 * Числа источника: из текста источника достаются все целые числа.
 *
 * Сравнение целочисленное: «5 000», «5000» и «5000 рублей» — одно число.
 */
function sourceAmounts(source: Source): Set<number> {
  return extractNumbers(source.text);
}

/**
 * Убирает из текста фрагменты, числа которых суммами не являются.
 *
 * Ссылка, метка персональных данных, ссылка на источник, номер документа и
 * дата вычищаются вместе со своими цифрами. Значения персональных данных
 * вычищаются тоже: цифры внутри телефона, ИНН или счёта — не сумма, а
 * утечка, которую ловит отдельная проверка.
 */
function stripServiceParts(text: string): string {
  let cleaned = text;
  for (const pattern of SERVICE_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(pattern.source, pattern.flags), " ");
  }
  for (const value of findRawPersonalDataValues(cleaned)) {
    cleaned = cleaned.split(value).join(" ");
  }
  return cleaned;
}

/**
 * Множитель разряда: «тыс.» — тысячи, «млн.» — миллионы.
 */
function magnitudeMultiplier(magnitude: string | undefined): number {
  if (magnitude === undefined) return 1;
  return /^млн|^миллион/iu.test(magnitude) ? 1_000_000 : 1_000;
}

/**
 * Число, заведомо суммой не являющееся.
 *
 * Порядковый номер («п. 3», «версия 2») и процент («10%», «5 процентов») —
 * не суммы.
 */
function isNotAmount(before: string, after: string): boolean {
  if (ORDINAL_BEFORE.test(before)) return true;
  return PERCENT_AFTER.test(after);
}

/**
 * Ближайшее денежное слово перед числом.
 *
 * Денежное слово делает число суммой даже без валюты: «стоимость 5000»,
 * «итого 9999». Между словом и числом других чисел быть не должно, иначе
 * слово относится не к этому числу.
 */
function moneyWordBefore(text: string, start: number): number | null {
  const window = text.slice(Math.max(0, start - 60), start);
  const match = MONEY_WORD.exec(window);
  if (match === null) return null;
  // Между денежным словом и числом не должно быть других чисел.
  if (/\d/u.test(window.slice(match.index + match[0].length))) return null;
  return match.index;
}

/**
 * Суммы, названные в тексте ответа.
 *
 * Число читается как сумма, если рядом с ним валюта («5000 ₽», «5 000
 * рублей», «50 тыс. рублей») или перед ним денежное слово («стоимость
 * 5000», «итого 9999»).
 *
 * Всё остальное — не сумма: сроки («120 минут»), количества («3 варианта»),
 * проценты («5%»), порядковые номера («п. 3»), номера документов и служебные
 * значения. Именно такое правило нужно, чтобы сверка шла с числами
 * источников, а не с любыми цифрами ответа: иначе срок «15 минут» из
 * ответа блокировался бы как сумма, которой нет в источнике.
 */
function extractAnswerAmounts(text: string): Set<number> {
  const cleaned = stripServiceParts(text);
  const amounts = new Set<number>();
  for (const match of cleaned.matchAll(new RegExp(NUMBER, "gu"))) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = cleaned.slice(Math.max(0, start - 60), start);
    const after = cleaned.slice(end, end + 40);

    if (isNotAmount(before, after)) continue;

    const integerPart = match[0].split(/[.,]/u)[0] ?? "";
    const digits = integerPart.replace(/[^\d]/gu, "");
    if (digits.length === 0) continue;
    const value = Number(digits);

    const currency = CURRENCY_AFTER.exec(after);
    if (currency !== null) {
      amounts.add(value * magnitudeMultiplier(currency.groups?.magnitude));
      continue;
    }

    if (moneyWordBefore(cleaned, start) !== null) {
      amounts.add(value);
      continue;
    }
  }
  return amounts;
}

export function validateAnswer(
  answer: CandidateAnswer,
  sources: Source[],
  allowedPersonalValues: readonly string[] = [],
): ValidationResult {
  const violations: ValidationViolation[] = [];

  if (sources.length === 0) {
    violations.push({
      code: "no_confirmed_source",
      detail: "Ответ без подтверждённого источника не отправляется клиенту.",
    });
  }

  const allowed = new Set<number>();
  for (const source of sources) {
    for (const amount of sourceAmounts(source)) allowed.add(amount);
  }

  // Проверяются и суммы, названные в тексте ответа, и суммы, заявленные
  // моделью в поле `amounts`: текст — то, что увидит клиент, поле —
  // дополнительный сигнал, который модель может и не заполнить.
  const claimed = new Set<number>();
  for (const amount of extractAnswerAmounts(answer.text)) claimed.add(amount);
  for (const amount of answer.amounts) claimed.add(Math.trunc(amount));

  for (const amount of claimed) {
    if (allowed.has(amount)) continue;
    violations.push({
      code: "amount_not_in_source",
      detail: `Сумма ${amount} не найдена ни в одном подтверждённом источнике.`,
    });
  }

  const sourceTexts = sources.map((source) => normalizeText(source.text));
  const sourceLocations = sources
    .map((source) => source.location)
    .filter((location): location is string => typeof location === "string" && location.length > 0)
    .map((location) => normalizeText(location));
  for (const citation of answer.citations) {
    const normalized = normalizeText(citation);
    // Цитата подтверждена, если это дословный фрагмент текста источника
    // либо ссылка на сам одобренный источник: модель часто указывает адрес
    // статьи вместо цитаты, и такой ответ по требованию «цитата по
    // одобренному источнику» допустим.
    const inText = sourceTexts.some((text) => text.includes(normalized));
    const isSourceLocation = sourceLocations.some(
      (location) => location.includes(normalized) || normalized.includes(location),
    );
    if (!inText && !isSourceLocation) {
      violations.push({
        code: "citation_not_in_source",
        detail: `Цитата «${citation}» отсутствует в подтверждённых источниках.`,
      });
    }
  }

  // Сырые ПД в исходящем тексте блокируют отправку. Значения, которые уже
  // известны серверу (восстановлены по таблице соответствий), утечкой не
  // считаются: клиент законно получает свои же данные обратно.
  const knownValues = new Set(allowedPersonalValues.map((value) => value.toLowerCase()));
  const leaked = findRawPersonalDataValues(answer.text).filter(
    (value) => !knownValues.has(value.toLowerCase()),
  );
  if (leaked.length > 0) {
    violations.push({
      code: "raw_pii_in_outgoing",
      detail: `В исходящем тексте остались необработанные персональные данные: ${leaked.join(", ")}.`,
    });
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Проверка исходящего текста на сырые персональные данные.
 *
 * Отдельная от `validateAnswer`: приветствие и уточняющий вопрос фактов не
 * содержат, поэтому источник им не нужен, но персональные данные в тексте
 * недопустимы в любом ответе — включая ответ без источников.
 *
 * Значения, которые уже известны серверу (восстановлены по таблице
 * соответствий), утечкой не считаются: клиент законно получает свои же
 * данные обратно. Значения из подтверждённых источников тоже не считаются
 * утечкой: название вендора или продукта из карточки каталога — это материал
 * заказчика, а не данные клиента, и без исключения исходящая проверка
 * блокировала бы любой ответ по каталогу.
 */
export function validateOutgoingText(
  text: string,
  allowedPersonalValues: readonly string[] = [],
  sourceTexts: readonly string[] = [],
): ValidationResult {
  const knownValues = new Set(allowedPersonalValues.map((value) => value.toLowerCase()));
  const sourceHaystack = sourceTexts.join("\n").toLowerCase();
  const leaked = findRawPersonalDataValues(text).filter((value) => {
    const lower = value.toLowerCase();
    if (knownValues.has(lower)) return false;
    if (sourceHaystack.includes(lower)) return false;
    return true;
  });
  if (leaked.length === 0) {
    return { valid: true, violations: [] };
  }
  return {
    valid: false,
    violations: [
      {
        code: "raw_pii_in_outgoing",
        detail: `В исходящем тексте остались необработанные персональные данные: ${leaked.join(", ")}.`,
      },
    ],
  };
}

/**
 * Обязательство, проверяемое перед записью в журнал (R11, ADR-0018).
 *
 * `deadlinePhrase` — формулировка срока так, как она написана в источнике:
 * именно она должна дословно в нём найтись.
 */
export type PromiseCheck = {
  text: string;
  deadlinePhrase: string;
};

/**
 * Проверка обязательства перед записью в журнал.
 *
 * Инварианты:
 * - формулировка срока обязана встречаться в тексте подтверждённого
 *   источника: обязательство без источника недопустимо;
 * - в тексте обязательства не должно быть сырых персональных данных: адрес
 *   клиента уходит в модель и трассу меткой, а не исходным значением.
 *
 * Проверка идёт по факту, а не по намерению: модель могла назвать срок,
 * которого в источнике нет, и код это не пропускает.
 */
export function validatePromise(
  promise: PromiseCheck,
  sources: readonly Source[],
  allowedPersonalValues: readonly string[] = [],
): ValidationResult {
  const violations: ValidationViolation[] = [];

  const normalizedPhrase = normalizeText(promise.deadlinePhrase);
  const confirmed = sources.some((source) =>
    normalizeText(source.text).includes(normalizedPhrase),
  );
  if (!confirmed) {
    violations.push({
      code: "deadline_not_in_source",
      detail: `Срок «${promise.deadlinePhrase}» отсутствует в подтверждённых источниках.`,
    });
  }

  const knownValues = new Set(
    allowedPersonalValues.map((value) => value.toLowerCase()),
  );
  const leaked = findRawPersonalDataValues(promise.text).filter(
    (value) => !knownValues.has(value.toLowerCase()),
  );
  if (leaked.length > 0) {
    violations.push({
      code: "raw_pii_in_outgoing",
      detail: `В тексте обязательства остались необработанные персональные данные: ${leaked.join(", ")}.`,
    });
  }

  return { valid: violations.length === 0, violations };
}
