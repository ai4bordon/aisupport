import type { Source } from "@/contracts/chat";
import { findRawPersonalData } from "@/core/mask";

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
  for (const citation of answer.citations) {
    const normalized = normalizeText(citation);
    const found = sourceTexts.some((text) => text.includes(normalized));
    if (!found) {
      violations.push({
        code: "citation_not_in_source",
        detail: `Цитата «${citation}» отсутствует в подтверждённых источниках.`,
      });
    }
  }

  const rawClasses = findRawPersonalData(answer.text);
  if (rawClasses.length > 0) {
    violations.push({
      code: "raw_pii_in_outgoing",
      detail: `В исходящем тексте остались необработанные персональные данные: ${rawClasses.join(", ")}.`,
    });
  }

  return { valid: violations.length === 0, violations };
}
