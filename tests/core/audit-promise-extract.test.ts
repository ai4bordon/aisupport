import { describe, expect, it } from "vitest";
import {
  candidateFromAnswer,
  extractPromise,
  findCommitments,
  findUnmarkedCommitment,
  promiseSentence,
  stripPromiseMarker,
  unconfirmedCommitmentRejection,
  type ConfirmedSource,
} from "@/core/promise-extract";

/**
 * Регресс-тесты волны исправлений по BUGSAUDIT-2026-11-27.md:
 *
 * - B8 — обязательство без строки-маркера уходит клиенту, но в журнал
 *   не попадает: ядро должно видеть такое обязательство и отклонять его;
 * - C18 — текст обещания формирует код, игнорируя формулировку модели:
 *   формулировка модели обязана сохраняться;
 * - C19 — маркер обещания удаляется только первым вхождением: удалять надо
 *   все вхождения, в том числе не в начале строки.
 */

/** Ответ с подтверждённым сроком, но без строки-маркера `ОБЕЩАНИЕ:`. */
const ANSWER_WITHOUT_MARKER =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.\n" +
  "Отправлю КП в течение 120 минут.";

/** Обычный ответ без обязательства. */
const ANSWER_WITHOUT_COMMITMENT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

/** Ответ со строкой-маркером. */
const ANSWER_WITH_MARKER =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.\n" +
  "ОБЕЩАНИЕ: Пришлю счёт | срок: 120 минут | источник: [1]";

describe("B8: обязательство без строки-маркера не остаётся незамеченным", () => {
  it("текст с обязательством, но без маркера, помечается как неподтверждённое", () => {
    const found = findCommitments(ANSWER_WITHOUT_MARKER);

    expect(found.marker).toBeNull();
    expect(found.unmarked).not.toBeNull();
    expect(found.unmarked?.deadline).toBe("120 минут");
    expect(found.unmarked?.text).toContain("Отправлю КП");
  });

  it("функция поиска возвращает неподтверждённое обязательство отдельным вызовом", () => {
    const unmarked = findUnmarkedCommitment(ANSWER_WITHOUT_MARKER);

    expect(unmarked).not.toBeNull();
    expect(unmarked?.deadline).toBe("120 минут");
    expect(Number.isNaN(Date.parse(unmarked?.dueAt ?? ""))).toBe(false);
  });

  it("текст без обязательства не помечается как неподтверждённое", () => {
    expect(findUnmarkedCommitment(ANSWER_WITHOUT_COMMITMENT)).toBeNull();
    expect(findCommitments(ANSWER_WITHOUT_COMMITMENT).unmarked).toBeNull();
  });

  it("ответ со строкой-маркером не считается неподтверждённым обязательством", () => {
    const found = findCommitments(ANSWER_WITH_MARKER);

    expect(found.marker).not.toBeNull();
    expect(found.marker?.text).toBe("Пришлю счёт");
    expect(found.marker?.deadline).toBe("120 минут");
    expect(found.marker?.sourceRef).toBe(1);
    expect(found.unmarked).toBeNull();
  });

  it("обязательство без маркера даёт отказ с признаком promise_not_confirmed", () => {
    const rejection = unconfirmedCommitmentRejection(ANSWER_WITHOUT_MARKER);

    expect(rejection).not.toBeNull();
    expect(rejection?.reason).toBe("promise_not_confirmed");
    expect(rejection?.detail).toContain("120 минут");
  });

  it("ответ без обязательства отказом не считается", () => {
    expect(unconfirmedCommitmentRejection(ANSWER_WITHOUT_COMMITMENT)).toBeNull();
  });

  it("пересказ условия из источника обязательством не считается", () => {
    // «Лицензия предоставляется в течение 120 минут» — описание условия,
    // а не обещание агента: отзыва по такому тексту быть не должно.
    expect(
      findUnmarkedCommitment(
        "Лицензия предоставляется в течение 120 минут после оплаты.",
      ),
    ).toBeNull();
  });

  it("оговорка с отрицанием обязательством не считается", () => {
    expect(
      findUnmarkedCommitment("Без срока не отправлю КП в течение 120 минут."),
    ).toBeNull();
  });

  it("текст ответа модели целиком не проходит как обязательство без срока", () => {
    // Обязательства без срока в журнал не пишется: `promises.due_at` не
    // может быть пустым, а неподтверждённый срок недопустим вовсе.
    expect(findUnmarkedCommitment("Отправлю КП после оплаты.")).toBeNull();
  });

  it("обязательство с календарной датой распознаётся", () => {
    const unmarked = findUnmarkedCommitment("Отправлю КП до 12.03.2026.");

    expect(unmarked).not.toBeNull();
    expect(unmarked?.deadline).toBe("12.03.2026");
  });

  it("отрицание через вспомогательный глагол снимает обязательство", () => {
    expect(
      findUnmarkedCommitment("Не смогу отправить КП в течение 120 минут."),
    ).toBeNull();
  });

  it("инфинитив глагола обязательством не считается", () => {
    // «Вернуть лицензию» — требование, а не обещание агента.
    expect(
      findUnmarkedCommitment("Нужно вернуть лицензию в течение 120 минут."),
    ).toBeNull();
  });
});

describe("C18: формулировка модели сохраняется в тексте обещания", () => {
  it("текст обещания содержит фразу модели, а не шаблон кода", () => {
    const sentence = promiseSentence({
      text: "Пришлю расчёт и коммерческое предложение",
      channel: "max",
      contactLabel: null,
      dueAt: "2026-03-12T12:00:00.000Z",
      deadlinePhrase: "120 минут",
    });

    expect(sentence).toContain("Пришлю расчёт и коммерческое предложение");
    expect(sentence).not.toContain("КП будет готово");
    expect(sentence).not.toContain("Счёт будет отправлен");
  });

  it("в веб-канале фраза модели сохраняется вместе с адресатом и сроком", () => {
    const sentence = promiseSentence({
      text: "Пришлю КП",
      channel: "email",
      contactLabel: "⟦EMAIL_1⟧",
      dueAt: "2026-03-12T12:00:00.000Z",
      deadlinePhrase: "120 минут",
    });

    expect(sentence).toContain("Пришлю КП");
    expect(sentence).toContain("⟦EMAIL_1⟧");
    expect(sentence).toContain("12.03.2026");
    expect(sentence).not.toContain("Счёт будет отправлен");
  });

  it("адресат, уже названный моделью, не вставляется в текст второй раз", () => {
    const sentence = promiseSentence({
      text: "Пришлю КП на ⟦EMAIL_1⟧",
      channel: "email",
      contactLabel: "⟦EMAIL_1⟧",
      dueAt: "2026-03-12T12:00:00.000Z",
      deadlinePhrase: "120 минут",
    });

    expect(sentence.match(/⟦EMAIL_1⟧/gu)).toHaveLength(1);
  });

  it("срок, названный моделью, не дублируется в тексте", () => {
    const sentence = promiseSentence({
      text: "Пришлю КП в течение 120 минут",
      channel: "max",
      contactLabel: null,
      dueAt: "2026-03-12T12:00:00.000Z",
      deadlinePhrase: "120 минут",
    });

    expect(sentence.match(/120 минут/gu)).toHaveLength(1);
    expect(sentence).not.toContain("12.03.2026");
  });

  it("неподтверждённый срок в формулировке модели не проходит в обещание", () => {
    // Формулировка модели уходит клиенту вместе с подтверждённым сроком,
    // поэтому срок, названный в ней, должен подтверждаться источником.
    const sources: ConfirmedSource[] = [
      {
        kind: "kb_article",
        id: "article-1",
        text: "Электронная лицензия предоставляется в течение 120 минут после оплаты.",
      },
    ];
    const candidate = candidateFromAnswer(
      "ОБЕЩАНИЕ: Пришлю счёт в течение 120 минут, но не позднее 15 минут | срок: 120 минут | источник: [1]",
      { channel: "max", externalChatId: "chat-1", clientText: null },
      sources,
    );

    expect(candidate).not.toBeNull();
    const extraction = extractPromise(candidate!, sources);

    expect(extraction.kind).toBe("rejected");
    if (extraction.kind !== "rejected") return;
    expect(extraction.reason).toBe("deadline_not_in_source");
  });
});

describe("C19: маркер обещания удаляется целиком и во всех вхождениях", () => {
  it("удаляются все маркеры в ответе", () => {
    const stripped = stripPromiseMarker(
      "ОБЕЩАНИЕ: Пришлю счёт | срок: 120 минут\n" +
        "Счёт будет отправлен.\n" +
        "ОБЕЩАНИЕ: Пришлю КП | срок: 120 минут",
    );

    expect(stripped).not.toContain("ОБЕЩАНИЕ");
    expect(stripped).not.toContain("срок: 120 минут");
    expect(stripped).toContain("Счёт будет отправлен.");
  });

  it("удаляется маркер, который стоит не в начале строки", () => {
    const stripped = stripPromiseMarker(
      "Спасибо за вопрос! ОБЕЩАНИЕ: Пришлю КП | срок: 120 минут",
    );

    expect(stripped).not.toContain("ОБЕЩАНИЕ");
    expect(stripped).not.toContain("срок: 120 минут");
    expect(stripped).toContain("Спасибо за вопрос!");
  });

  it("маркер не в начале строки всё равно распознаётся как обязательство", () => {
    const found = findCommitments(
      "Спасибо за вопрос! ОБЕЩАНИЕ: Пришлю КП | срок: 120 минут | источник: [1]",
    );

    expect(found.marker).not.toBeNull();
    expect(found.marker?.text).toBe("Пришлю КП");
    expect(found.marker?.deadline).toBe("120 минут");
    expect(found.marker?.sourceRef).toBe(1);
  });

  it("текст без маркера не меняется", () => {
    const text = "Электронная лицензия предоставляется в течение 120 минут.";

    expect(stripPromiseMarker(text)).toBe(text);
  });

  it("слово «обещание» в тексте маркером не считается", () => {
    const text = "Ваше обещание учтено: лицензия предоставляется в течение 120 минут.";

    expect(stripPromiseMarker(text)).toBe(text);
    expect(findCommitments(text).marker).toBeNull();
  });
});
