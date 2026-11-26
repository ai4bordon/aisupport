import { describe, expect, it } from "vitest";
import { validateAnswer } from "@/core/validate";
import type { Source } from "@/contracts/chat";

const ARTICLE: Source = {
  kind: "kb_article",
  id: "11111111-1111-4111-8111-111111111111",
  title: "Лицензирование",
  location: "п. 3",
  text: "Электронная лицензия предоставляется в течение 120 минут после оплаты. Стоимость 5000 рублей.",
};

describe("валидатор ответов", () => {
  it("принимает ответ, у которого сумма и цитата совпадают с источником", () => {
    const result = validateAnswer(
      {
        text: "Электронная лицензия предоставляется в течение 120 минут после оплаты.",
        amounts: [5000],
        citations: ["Электронная лицензия предоставляется в течение 120 минут после оплаты."],
      },
      [ARTICLE],
    );

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("сумма, отсутствующая среди источников, даёт violation amount_not_in_source", () => {
    const result = validateAnswer(
      {
        text: "Стоимость 9999 рублей.",
        amounts: [9999],
        citations: [],
      },
      [ARTICLE],
    );

    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      "amount_not_in_source",
    );
  });

  it("цитата, отсутствующая в источнике, даёт violation citation_not_in_source", () => {
    const result = validateAnswer(
      {
        text: "Электронная лицензия предоставляется в течение трёх дней.",
        amounts: [],
        citations: ["Электронная лицензия предоставляется в течение трёх дней."],
      },
      [ARTICLE],
    );

    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      "citation_not_in_source",
    );
  });

  it("пустой список источников даёт valid=false", () => {
    const result = validateAnswer(
      {
        text: "Электронная лицензия предоставляется в течение 120 минут.",
        amounts: [],
        citations: [],
      },
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("исходящий текст с сырым ФИО, телефоном, email, ИНН, счётом или паспортом отклоняется", () => {
    const cases = [
      "Ответ для Иванова Ивана Ивановича.",
      "Звоните на +7 (495) 123-45-67.",
      "Пишите на ivanov@example.com.",
      "ИНН клиента 7707083893.",
      "Счёт 40702810100000012345.",
      "Паспорт 45 08 123456.",
    ];

    for (const text of cases) {
      const result = validateAnswer({ text, amounts: [], citations: [] }, [ARTICLE]);

      expect(result.valid, `текст не отклонён: ${text}`).toBe(false);
      expect(result.violations.map((violation) => violation.code)).toContain(
        "raw_pii_in_outgoing",
      );
    }
  });

  it("текст только с метками ПД проходит проверку", () => {
    const result = validateAnswer(
      {
        text: "Клиент ⟦PERSON_1⟧, телефон ⟦PHONE_1⟧, email ⟦EMAIL_1⟧.",
        amounts: [],
        citations: [],
      },
      [ARTICLE],
    );

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("сравнение цитат нечувствительно к пробелам и регистру", () => {
    const result = validateAnswer(
      {
        text: "Электронная лицензия предоставляется в течение 120 минут после оплаты.",
        amounts: [],
        citations: ["электронная  лицензия предоставляется   в течение 120 минут после оплаты"],
      },
      [ARTICLE],
    );

    expect(result.valid).toBe(true);
  });

  it("нарушение возвращает понятную причину в detail", () => {
    const result = validateAnswer(
      { text: "Стоимость 9999 рублей.", amounts: [9999], citations: [] },
      [ARTICLE],
    );

    expect(result.violations[0]?.detail.length).toBeGreaterThan(0);
  });
});
