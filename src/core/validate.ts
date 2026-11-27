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
 * Суммы считает только код: валидатор лишь сверяет числа, пришедшие от
 * модели, с числами источников — сам он ничего не вычисляет.
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
 * Числа источника: из текста источника достаются все целые числа.
 *
 * Сравнение целочисленное: «5 000», «5000» и «5000 рублей» — одно число.
 */
function sourceAmounts(source: Source): Set<number> {
  const amounts = new Set<number>();
  for (const match of source.text.matchAll(/\d[\d\s ]*/g)) {
    const digits = match[0].replace(/[^\d]/g, "");
    if (digits.length === 0) continue;
    amounts.add(Number(digits));
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

  for (const amount of answer.amounts) {
    if (!allowed.has(Math.trunc(amount))) {
      violations.push({
        code: "amount_not_in_source",
        detail: `Сумма ${amount} не найдена ни в одном подтверждённом источнике.`,
      });
    }
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
