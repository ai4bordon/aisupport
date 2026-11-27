import { describe, expect, it } from "vitest";
import { validateAnswer } from "@/core/validate";
import type { Source } from "@/contracts/chat";

/**
 * Аудит BUGSAUDIT-2026-11-27, находка [B4].
 *
 * Валидатор сумм сверял самоотчёт модели (`answer.amounts`), а не текст
 * ответа: модель возвращала `amounts: []`, а в тексте писала «итого 9999 ₽»
 * — и ответ уходил клиенту.
 *
 * Проверяется главное свойство: сумма, названная в тексте ответа, сверяется
 * с источниками так же, как сумма из поля `amounts`. Поле `amounts` при этом
 * остаётся дополнительным сигналом, а не единственным.
 */

const ARTICLE: Source = {
  kind: "kb_article",
  id: "11111111-1111-4111-8111-111111111111",
  title: "Лицензирование",
  location: "п. 3",
  text: "Электронная лицензия предоставляется в течение 120 минут после оплаты. Стоимость 5000 рублей.",
};

/** Коды нарушений, связанных с суммами. */
function amountViolations(result: { violations: Array<{ code: string }> }): string[] {
  return result.violations
    .map((violation) => violation.code)
    .filter((code) => code === "amount_not_in_source");
}

describe("валидатор сумм сверяет текст ответа, а не самоотчёт модели (B4)", () => {
  it("сумма в тексте ответа без источника — нарушение, даже если amounts пуст", () => {
    const result = validateAnswer(
      {
        text: "Итого 9999 ₽",
        amounts: [],
        citations: [],
      },
      [ARTICLE],
    );

    expect(result.valid).toBe(false);
    expect(amountViolations(result)).toContain("amount_not_in_source");
  });

  it("сумма из текста источника нарушением не является", () => {
    const result = validateAnswer(
      {
        text: "Стоимость 5000 рублей.",
        amounts: [],
        citations: [],
      },
      [ARTICLE],
    );

    expect(amountViolations(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("сумма в тексте ответа сверяется с источниками и при непустом amounts", () => {
    const result = validateAnswer(
      {
        text: "Итого 9999 ₽, стоимость 5000 рублей.",
        amounts: [5000],
        citations: [],
      },
      [ARTICLE],
    );

    expect(amountViolations(result)).toHaveLength(1);
    expect(result.violations[0]?.detail).toContain("9999");
  });

  it("amounts остаётся дополнительным сигналом: сумма без источника в поле даёт нарушение", () => {
    const result = validateAnswer(
      {
        text: "Стоимость 5000 рублей.",
        amounts: [7777],
        citations: [],
      },
      [ARTICLE],
    );

    expect(amountViolations(result)).toHaveLength(1);
    expect(result.violations[0]?.detail).toContain("7777");
  });

  it("разделители разрядов — обычный пробел и неразрывный пробел дают одно число", () => {
    const withNbsp: Source = {
      ...ARTICLE,
      text: "Стоимость 5 000 рублей.",
    };

    const result = validateAnswer(
      {
        text: "Итого 5 000 ₽",
        amounts: [],
        citations: [],
      },
      [withNbsp],
    );

    expect(amountViolations(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("сроки, количества, номера документов, номера источников и метки ПД суммами не считаются", () => {
    const result = validateAnswer(
      {
        text: [
          "Выдаём в течение 120 минут.",
          "Стоимость 5000 рублей.",
          "Документ № 12345.",
          "Источник [1].",
          "Клиент ⟦PERSON_1⟧.",
          "Всего 3 варианта лицензии.",
          "Скидка 5% по программе.",
        ].join(" "),
        amounts: [],
        citations: [],
      },
      [ARTICLE],
    );

    expect(amountViolations(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("процент с пробелом и словом суммой не считается", () => {
    // Регрессия: «скидка 3 %» и «скидка 3 процента» распознавались как
    // сумма, и ответ о скидке в пределах порога блокировался проверкой
    // сумм — агент не мог ответить клиенту на разрешённый вопрос.
    const result = validateAnswer(
      {
        text: [
          "Скидку 3 % дадим.",
          "Скидка составит 3 процента.",
          "Скидка 5% по программе.",
        ].join(" "),
        amounts: [],
        citations: [],
      },
      [ARTICLE],
    );

    expect(amountViolations(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("нарушение по сумме называет саму сумму в detail", () => {
    const result = validateAnswer(
      {
        text: "Итого 9999 ₽",
        amounts: [],
        citations: [],
      },
      [ARTICLE],
    );

    const amountViolation = result.violations.find(
      (violation) => violation.code === "amount_not_in_source",
    );
    expect(amountViolation?.detail).toContain("9999");
  });
});
