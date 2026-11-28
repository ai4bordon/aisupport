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

    // Расчётный счёт клиенту не показывается: метка остаётся меткой.
    const restored = restoreMaskedData(maskedText, mapping);
    expect(restored).toContain("Иванов Иван Иванович");
    expect(restored).toContain("ivanov@example.com");
    expect(restored).not.toContain("40702810100000012345");
  });

  it("восстановление возвращает и скрытые классы по явному запросу", () => {
    // Служебный сценарий, где значение нужно вернуть целиком: например,
    // запись в журнал для служебных нужд. По умолчанию карта скрыта.
    const { maskedText, mapping } = maskPersonalData("карта 4276 1234 5678 9012");

    const restored = restoreMaskedData(maskedText, mapping, new Set());
    expect(restored).toContain("4276 1234 5678 9012");
  });

  it("восстановление не трогает метки без соответствия", () => {
    expect(restoreMaskedData("Значение ⟦PERSON_9⟧", {})).toBe("Значение ⟦PERSON_9⟧");
  });

  it("маскирует карту с пробелами и дефисами", () => {
    // Регрессия (аудит 28.11): правило ловило только слитные 16 и 20
    // цифр, поэтому карта «4276 1234 5678 9012» уходила в базу и в
    // модель немаскированной, и агент повторял её клиенту.
    const withSpaces = maskPersonalData("карта 4276 1234 5678 9012");
    expect(withSpaces.maskedText).toContain("⟦BANK_1⟧");
    expect(withSpaces.maskedText).not.toContain("4276");
    expect(withSpaces.maskedText).not.toContain("9012");

    const withDashes = maskPersonalData("карта 4276-1234-5678-9012");
    expect(withDashes.maskedText).toContain("⟦BANK_1⟧");
    expect(withDashes.maskedText).not.toContain("4276");
  });

  it("маскирует расчётный счёт с пробелами", () => {
    const result = maskPersonalData("счёт 40817 810 0 9991 0004312");

    expect(result.maskedText).toContain("⟦BANK_1⟧");
    expect(result.maskedText).not.toContain("40817");
    expect(result.maskedText).not.toContain("0004312");
  });

  it("маскирует СНИЛС", () => {
    const result = maskPersonalData("снилс 123-456-789 00");

    expect(result.maskedText).toContain("⟦SNILS_1⟧");
    expect(result.maskedText).not.toContain("123-456-789");
  });

  it("обычные числа маскированием не затрагиваются", () => {
    // Цена и количество — не персональные данные: маскировать их нельзя,
    // иначе в ответе пропадёт сумма.
    const result = maskPersonalData("цена 34 717 рублей, количество 50 мест");

    expect(result.maskedText).toContain("34 717");
    expect(result.maskedText).toContain("50");
    expect(result.maskedText).not.toContain("⟦");
  });

  it("номер карты не восстанавливается в ответе клиенту", () => {
    // Регрессия (аудит 28.11): клиент прислал карту, модель её
    // процитировала, и номер возвращался в ответе — карта размножалась по
    // переписке. Номер клиенту не нужен, поэтому метка остаётся меткой.
    const { maskedText, mapping } = maskPersonalData("карта 4276 1234 5678 9012");

    expect(maskedText).toContain("⟦BANK_1⟧");

    const restored = restoreMaskedData("Проверьте карту ⟦BANK_1⟧", mapping);
    // Ни цифр, ни сырой метки: клиенту показывается понятная фраза.
    expect(restored).toBe("Проверьте карту номер карты скрыт");
    expect(restored).not.toContain("4276");
    expect(restored).not.toContain("9012");
    expect(restored).not.toContain("⟦");
  });

  it("остальные персональные данные восстанавливаются как раньше", () => {
    // Клиент законно получает свои же данные обратно: правило скрытия
    // касается только карты, СНИЛС и паспорта.
    const { mapping } = maskPersonalData("почта ivanov@example.com");
    const restored = restoreMaskedData("Письмо на ⟦EMAIL_1⟧", mapping);

    expect(restored).toBe("Письмо на ivanov@example.com");
  });

  it("название заказчика не считается персональными данными", () => {
    // Регрессия живьёма (аудит 28.11): ответ «в личном кабинете АО
    // «Софтлайн»» маскировался как организация, и проверка персональных
    // данных отвергала его как утечку — вопрос про пароль то отвечал, то
    // уходил в эскалацию.
    for (const text of [
      "В личном кабинете ПАО «Софтлайн».",
      "В личном кабинете АО «Софтлайн».",
      "Обратитесь в поддержку Софтлайн.",
      "Обратитесь в поддержку Softline.",
    ]) {
      const { maskedText } = maskPersonalData(text);
      expect(maskedText, text).not.toContain("⟦ORG_");
      expect(findRawPersonalDataValues(text), text).toEqual([]);
    }
  });

  it("текст без ПД не меняется", () => {
    const text = "Как получить электронную лицензию?";
    const { maskedText, maskedFieldsCount } = maskPersonalData(text);

    expect(maskedText).toBe(text);
    expect(maskedFieldsCount).toBe(0);
  });

  it("способ доставки не считается ФИО", () => {
    // Регрессия: на живом стенде ответ про доставку содержал «Почтой
    // России», правило «два слова с заглавной буквы» считало это ФИО, и
    // проверка исходящего текста блокировала ответ с кодом 422.
    const text = "Доставка Почтой России по всей стране";

    const { maskedText, maskedFieldsCount } = maskPersonalData(text);

    expect(maskedText).toBe(text);
    expect(maskedFieldsCount).toBe(0);
    expect(findRawPersonalDataValues(text)).toEqual([]);
  });

  it("предметная пара не считается ФИО", () => {
    const text = "Список Товаров и Перечень Услуг";

    expect(findRawPersonalDataValues(text)).toEqual([]);
  });

  it("ФИО по-прежнему маскируется", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData("Иван Иванов");

    expect(maskedText).toBe("⟦PERSON_1⟧");
    expect(maskedFieldsCount).toBe(1);
  });

  it("ФИО с отчеством по-прежнему маскируется", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData("Иванов Иван Иванович");

    expect(maskedText).toContain("⟦PERSON_1⟧");
    expect(maskedFieldsCount).toBe(1);
  });

  it("имя и фамилия в родительном падеже маскируются", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData("Мария Петрова");

    expect(maskedText).toContain("⟦PERSON_1⟧");
    expect(maskedFieldsCount).toBe(1);
  });

  it("имя после предлога по-прежнему маскируется", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData("вопрос для Иванова.");

    expect(maskedText).toContain("⟦PERSON_1⟧");
    expect(maskedFieldsCount).toBe(1);
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

  it("«адрес почты» не считается почтовым адресом", () => {
    // Регрессия: ответ по восстановлению пароля содержал «введите адрес
    // почты», и исходящая проверка блокировала его как утечку адреса.
    const text = "Введите адрес почты, на который зарегистрирована учётная запись.";

    const { maskedText, maskedFieldsCount } = maskPersonalData(text);

    expect(maskedText).toBe(text);
    expect(maskedFieldsCount).toBe(0);
  });

  it("география после предлога не считается именем", () => {
    // Регрессия: «Стоимость доставки по России» ловилось правилом «имя после
    // предлога», и ответ блокировался как утечка ФИО.
    const text = "Стоимость доставки по России";

    const { maskedText, maskedFieldsCount } = maskPersonalData(text);

    expect(maskedText).toBe(text);
    expect(maskedFieldsCount).toBe(0);
  });

  it("имя после предлога по-прежнему маскируется", () => {
    const { maskedText, maskedFieldsCount } = maskPersonalData("вопрос для Иванова.");

    expect(maskedText).toContain("⟦PERSON_1⟧");
    expect(maskedFieldsCount).toBe(1);
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
