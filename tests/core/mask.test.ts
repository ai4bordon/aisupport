import { describe, expect, it } from "vitest";
import { maskPersonalData, restoreMaskedData, findRawPersonalDataValues } from "@/core/mask";

const ORIGINAL = [
  "Иванов Иван Иванович из ООО «Ромашка»,",
  "адрес: ул. Ленина, д. 5,",
  "телефон +7 (495) 123-45-67,",
  "email ivanov@example.com,",
  "ИНН 7707083893,",
  "расчётный счёт 40702810100000012345,",
  "паспорт 45 08 123456.",
].join(" ");

describe("маскирование персональных данных", () => {
  it("заменяет все поддержанные классы ПД метками", () => {
    const { maskedText } = maskPersonalData(ORIGINAL);

    expect(maskedText).toContain("⟦PERSON_1⟧");
    expect(maskedText).toContain("⟦ORG_1⟧");
    expect(maskedText).toContain("⟦ADDRESS_1⟧");
    expect(maskedText).toContain("⟦PHONE_1⟧");
    expect(maskedText).toContain("⟦EMAIL_1⟧");
    expect(maskedText).toContain("⟦INN_1⟧");
    expect(maskedText).toContain("⟦BANK_1⟧");
    expect(maskedText).toContain("⟦PASSPORT_1⟧");
  });

  it("в маскированном тексте нет исходных значений", () => {
    const { maskedText } = maskPersonalData(ORIGINAL);

    for (const secret of [
      "Иванов",
      "Иван Иванович",
      "Ромашка",
      "Ленина",
      "495",
      "ivanov@example.com",
      "7707083893",
      "40702810100000012345",
      "123456",
    ]) {
      expect(maskedText, `в маскированном тексте осталось ${secret}`).not.toContain(secret);
    }
  });

  it("одно и то же значение получает одну метку в рамках диалога", () => {
    const text = "Телефон +7 (495) 123-45-67, второй телефон +7 (495) 123-45-67.";

    const first = maskPersonalData(text);
    expect(first.maskedText).toContain("⟦PHONE_1⟧");
    expect(first.maskedText.match(/⟦PHONE_1⟧/g)).toHaveLength(2);
    expect(first.maskedFieldsCount).toBe(1);

    const second = maskPersonalData("И ещё +7 (495) 123-45-67.", {
      mapping: first.mapping,
    });
    expect(second.maskedText).toContain("⟦PHONE_1⟧");
    expect(second.maskedFieldsCount).toBe(0);
  });

  it("разные значения одного класса получают разные метки", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData(
      "Пишите на a@example.com или b@example.com.",
    );

    expect(maskedText).toContain("⟦EMAIL_1⟧");
    expect(maskedText).toContain("⟦EMAIL_2⟧");
    expect(maskedFieldsCount).toBe(2);
  });

  it("restoreMaskedData возвращает исходный текст", () => {
    const { maskedText, mapping } = maskPersonalData(ORIGINAL);

    expect(restoreMaskedData(maskedText, mapping)).toBe(ORIGINAL);
  });

  it("восстановление не трогает метки без соответствия", () => {
    expect(restoreMaskedData("Значение ⟦PERSON_9⟧", {})).toBe("Значение ⟦PERSON_9⟧");
  });

  it("текст без ПД не меняется", () => {
    const text = "Как получить электронную лицензию?";
    const { maskedText, maskedFieldsCount } = maskPersonalData(text);

    expect(maskedText).toBe(text);
    expect(maskedFieldsCount).toBe(0);
  });

  it("обычные слова в родительном падеже не считаются именем", () => {
    // Регрессия: правило «имя после предлога» с флагом `i` ловило «ней» в
    // «перейдите по ней», и живой ответ агента блокировался как утечка ПД.
    const text =
      "На форме авторизации предусмотрена ссылка «восстановление пароля» — перейдите по ней, чтобы восстановить доступ.";

    const { maskedText, maskedFieldsCount } = maskPersonalData(text);

    expect(maskedText).toBe(text);
    expect(maskedFieldsCount).toBe(0);
  });

  it("имя после предлога по-прежнему маскируется", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData("вопрос для Иванова.");

    expect(maskedText).toContain("⟦PERSON_1⟧");
    expect(maskedFieldsCount).toBe(1);
  });

  it("«адрес электронной почты» не считается почтовым адресом", () => {
    // Регрессия: живая модель писала «укажите адрес электронной почты», и
    // валидатор считал это утечкой почтового адреса, блокируя ответ.
    const text = "Укажите адрес электронной почты, на который зарегистрирован аккаунт.";

    const { maskedText, maskedFieldsCount } = maskPersonalData(text);

    expect(maskedText).toBe(text);
    expect(maskedFieldsCount).toBe(0);
  });

  it("наименование заказчика не считается утечкой персональных данных", () => {
    // Регрессия: приветствие с названием компании блокировалось исходящей
    // проверкой как утечка ПД клиента. Во входящем тексте организация
    // маскируется, но в исходящей проверке наименование заказчика — это
    // константа продукта, а не данные клиента.
    const text = "Здравствуйте! Я агент службы поддержки ПАО «Софтлайн».";

    expect(findRawPersonalDataValues(text)).not.toContain("ПАО «Софтлайн»");
  });

  it("почтовый адрес по-прежнему маскируется", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData("адрес: ул. Ленина, д. 5");

    expect(maskedText).toContain("⟦ADDRESS_1⟧");
    expect(maskedFieldsCount).toBe(1);
  });
});
