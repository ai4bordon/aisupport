/**
 * Работа с каталогом продуктов в ядре агента (R1a, R1b).
 *
 * Каталог — это снимок фида заказчика: 135 951 позиция с ценой, наличием и
 * параметрами. Цена и наличие взяты из снимка, а не подтверждены в реальном
 * времени, поэтому ответ всегда сопровождается ссылкой на карточку и
 * указанием источника цены.
 *
 * Два сценария заказчика:
 *
 * - клиент знает продукт: агент находит его в каталоге, показывает версии и
 *   цену, а если не хватает данных (количество, срок лицензии, тип
 *   развёртывания) — задаёт уточняющие вопросы;
 * - клиент не знает продукт: агент выясняет требования и подбирает два-три
 *   подходящих варианта с обоснованием.
 *
 * Суммы считает код: цена берётся из карточки каталога, а не из ответа
 * модели, поэтому модель не может назвать другую сумму.
 */

import { getPool } from "@/db/pool";
import { catalog, type CatalogItem } from "@/modules/catalog";
import {
  detectDomain,
  domainCategoryMarkers,
  type CatalogDomain,
} from "@/core/catalog-domain";
import type { IntentClass } from "@/core/intents";

/** Поля, которые клиент указывает для подбора лицензии. */
export type RequirementSlots = {
  /** Количество лицензий или пользователей. */
  quantity: number | null;
  /** Срок лицензии в месяцах. */
  termMonths: number | null;
  /** Тип развёртывания: «сервер» или «облако». */
  deployment: string | null;
  /** Вендор, если клиент его назвал. */
  vendor: string | null;
  /**
   * Бюджет клиента: `null` — не выяснен, `"нет"` — не ограничен, иначе сумма
   * в рублях строкой.
   *
   * Строкой, а не числом, потому что состояний три: «бюджет не выяснен»,
   * «бюджета нет» и «бюджет такой-то». Числом первые два состояния не
   * различить, и вопрос о бюджете повторялся бы по кругу.
   */
  budget: string | null;
  /**
   * Название продукта, как его понял агент.
   *
   * Хранится в диалоге: ответ клиента на уточняющий вопрос («нужно 10 штук»)
   * названия продукта не содержит, и без сохранённого названия поиск по
   * каталогу не нашёл бы позицию.
   */
  productQuery: string | null;
  /**
   * Режим подбора: клиент сказал, что не знает нужный продукт.
   *
   * В этом режиме подбор идёт по предметной области задачи, а не по словам
   * запроса: без этого ответ на уточняющий вопрос («бюджета нет, инфраструктура
   * своя») уводил поиск по слову «инфраструктура» мимо почтовой защиты.
   */
  discovery: string | null;
  /**
   * Предметная область задачи, определённая по первому сообщению.
   *
   * Сохраняется в диалоге: ответ на уточняющий вопрос («бюджета нет,
   * инфраструктура своя») уже не содержит признаков домена, а подбор должен
   * остаться в почтовой безопасности.
   */
  domain: string | null;
};

/** Слоты, которые нужно уточнить: порядок соответствует порядку вопросов. */
export const REQUIRED_SLOTS: Array<keyof RequirementSlots> = [
  "quantity",
  "termMonths",
  "deployment",
];

/**
 * Слоты, которые уточняются, когда продукт не назван.
 *
 * Порядок другой: без названия продукта сначала выясняется, что нужно
 * клиенту, и только потом подбирается вариант.
 */
export const DISCOVERY_SLOTS: Array<keyof RequirementSlots> = [
  "quantity",
  "budget",
  "deployment",
  "termMonths",
];

/** Вопросы по слотам — задаются по одному. */
export const SLOT_QUESTIONS: Record<keyof RequirementSlots, string> = {
  quantity: "Сколько лицензий (или пользователей) нужно?",
  termMonths: "На какой срок нужна лицензия — 12 месяцев или больше?",
  deployment: "Как разворачиваем — на сервере заказчика или в облаке?",
  vendor: "Какого вендора рассматриваете?",
  budget: "Есть ли ограничение по бюджету?",
  productQuery: "Какой продукт вас интересует?",
  discovery: "Какую задачу решаете?",
  domain: "В какой области нужна помощь?",
};

/**
 * Разбирает наименование фида на название, редакцию и количество.
 *
 * В фиде наименование склеивает всё сразу: «MDaemon Technologies, Ltd.
 * MDaemon Security Gateway for Email Servers (лицензия с подпиской на
 * обновления на 1 год), 50». Название без вендора и редакции отдельно
 * выглядит как «Ltd. Netwin SurgeMail» или «Веб Dr.Web».
 */
type ParsedName = {
  name: string;
  edition: string | null;
  quantityText: string | null;
};

/**
 * Разбирает наименование позиции.
 *
 * Вендор отделяется по полному названию производителя, редакция — по
 * содержимому в скобках и по обороту «на N год», количество — по хвосту
 * с числом.
 */
export function parseProductName(rawName: string, vendor: string | null): ParsedName {
  let name = rawName.trim();

  // Вендор в начале наименования.
  if (vendor !== null) {
    const escaped = vendor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    name = name.replace(new RegExp(`^${escaped}\\s*`, "iu"), "").trim();
  }

  // Редакция в скобках: «(лицензия с подпиской на обновления на 1 год)».
  let edition: string | null = null;
  const bracket = name.match(/\(([^)]*)\)/u);
  if (bracket?.[1] !== undefined) {
    edition = bracket[1].trim();
    name = name.replace(bracket[0], " ").trim();
  }

  // Количество в хвосте: «…, 50», «…, 50 пользователей» или «… на 50 ПК».
  // Слово после числа тоже убирается: иначе в названии оставался хвост
  // «, 50 пользователей», а количество дублировалось ещё и в отдельном поле.
  let quantityText: string | null = null;
  const tail = name.match(
    /,\s*(\d+)\s*(?:пользовател[\p{L}\p{N}]*|пк|шт[\p{L}\p{N}]*|устройств[\p{L}\p{N}]*|мест[\p{L}\p{N}]*|лицензи[\p{L}\p{N}]*)?\s*$/iu,
  );
  if (tail?.[1] !== undefined) {
    quantityText = tail[1];
    name = name.replace(tail[0], "").trim();
  } else {
    const inline = name.match(
      /\s+на\s+(\d+)\s+(?:ПК|пк|пользовател[\p{L}\p{N}]*|мест[\p{L}\p{N}]*|устройств[\p{L}\p{N}]*)\s*$/iu,
    );
    if (inline?.[1] !== undefined) {
      quantityText = inline[1];
      name = name.replace(inline[0], "").trim();
    }
  }

  // Оборот «на 1 год» — редакция. В фиде он иногда повторяется («на 1 год
  // на 1 год»), поэтому все обороты срока убираются из названия, а в
  // редакцию попадает первый.
  const term = name.match(
    /\s+(на\s+\d+\s+(?:год|лет|месяц[\p{L}\p{N}]*))\s*(?:с\s+подпиской\s+на\s+обновления\s+на\s+\d+\s+\w+)?\s*$/iu,
  );
  if (term?.[1] !== undefined && edition === null) {
    edition = term[1].trim();
  }
  name = name
    .replace(/\s+на\s+\d+\s+(?:год|лет|месяц[\p{L}\p{N}]*)/giu, "")
    .trim();

  return {
    // Пробелы перед знаками препинания и двоеточие после названия — мусор
    // фида: в ответе это читалось как «Netwin SurgeMail , 50 пользователей».
    name: name
      .replace(/\s+([,;:])/gu, "$1")
      .replace(/\s{2,}/gu, " ")
      .trim(),
    edition,
    quantityText,
  };
}

/** Найденная позиция каталога вместе с данными для ответа. */
export type CatalogMatch = {
  offerId: string;
  /**
   * Название позиции без вендора и без редакции.
   *
   * В фиде всё склеено в одном наименовании («MDaemon Technologies, Ltd.
   * MDaemon Security Gateway …, 50»), и в ответе это читалось как «Ltd.
   * Netwin SurgeMail» или «Веб Dr.Web». Вендор и редакция вынесены в
   * отдельные поля.
   */
  name: string;
  /** Производитель: отдельное поле, в название не вклеивается. */
  vendor: string | null;
  /**
   * Редакция и условия поставки: «на 1 год», «с подпиской на обновления»,
   * «продление».
   */
  edition: string | null;
  price: number;
  currency: string;
  available: boolean;
  priceConfirmed: boolean;
  feedDate: string;
  snapshotHash: string;
  /** Ссылка на карточку в store.softline.ru. */
  url: string | null;
  /** Параметры позиции: количество лицензий, срок, развёртывание. */
  params: Record<string, string | string[]>;
  /**
   * Исходная позиция каталога.
   *
   * Нужна для проверки слотов: параметры позиции в ответе сведены к строкам,
   * а проверка работает с исходными значениями.
   */
  item: CatalogItem;
};

/** Результат подбора. */
export type CatalogLookup = {
  /** Найденные позиции. */
  matches: CatalogMatch[];
  /** Название продукта, как его понял агент. */
  productQuery: string | null;
  /** Незакрытые слоты: их нужно уточнить у клиента. */
  missingSlots: Array<keyof RequirementSlots>;
  /** Предметная область задачи, определённая по запросу. */
  domain: CatalogDomain;
  /** Вендор, определённый по запросу или взятый из сохранённого слота. */
  vendor: string | null;
};

/**
 * Слова, которые не являются названием продукта.
 *
 * По ним каталог не ищется: «нужен», «хочу», «сколько стоит» — это слова
 * запроса, а не продукт. Сюда же входят слова про количество сотрудников:
 * «защита почты для 50 сотрудников» — это описание задачи, а не название
 * позиции, и поиск по всей фразе не находил ничего.
 */
const STOP_WORDS = new Set([
  "нужен",
  "нужна",
  "нужно",
  "нужны",
  "хочу",
  "хотел",
  "хотим",
  "какой",
  "какая",
  "какие",
  "сколько",
  "стоит",
  "стоимость",
  "цена",
  "цены",
  "и",
  "в",
  "на",
  "для",
  "по",
  "продукт",
  "товар",
  "лицензия",
  "лицензию",
  "лицензии",
  "лицензий",
  "подписка",
  "подпиской",
  "обновлениями",
  "подскажите",
  "подскажи",
  "помогите",
  "помоги",
  "посоветуйте",
  "посоветуй",
  "мне",
  "нам",
  "пожалуйста",
  "а",
  "с",
  "к",
  "что",
  "как",
  "сотрудник",
  "сотрудников",
  "сотрудника",
  "пользовател",
  "пользователей",
  "пользователя",
  "человек",
  "человека",
  "людей",
  "лиц",
  "мест",
  "рабочих",
  "места",
]);

/** Стоп-слова для поиска по вендору. */
const VENDOR_STOP_WORDS = new Set([
  "пожалуйста",
  "нужен",
  "нужна",
  "хочу",
  "какой",
  "какая",
  "стоимость",
  "цена",
  "и",
  "в",
  "на",
  "для",
]);

/**
 * Фразы, которыми клиент говорит, что не знает нужный продукт.
 *
 * Клиент не называет продукт — он описывает задачу. Такие фразы не должны
 * превращаться в название продукта: поиск по словам «не знаю но защитить
 * почту» находил «Защитный чехол с ремнем на плечо».
 */
const UNKNOWN_PRODUCT_PATTERNS: RegExp[] = [
  /не\s+(знаю|понял[аи]?)[,\s]+(что|какой|какая|какие)\s+(нужно|надо|нужен|нужна|выбрать|взять)/iu,
  /не\s+знаю[,\s]/iu,
  /что\s+(лучше|посоветуйт[ео]?|выбрать|взять|мне\s+подойд[её]т)/iu,
  /подскажите[,\s]+что\s+(нужно|взять|выбрать)/iu,
  /помогите\s+(подобрать|выбрать)/iu,
  /подобрать\s+(продукт|вариант|решение)/iu,
];

/**
 * Извлекает название продукта из сообщения.
 *
 * Из текста убираются слова запроса и служебные слова; остаток считается
 * названием продукта. Пустой остаток означает, что клиент назвал продукт
 * неявно («сколько стоит?») — тогда каталог не ищется по имени.
 *
 * Фразы «не знаю, что нужно» и «подскажите, что выбрать» означают, что
 * клиент продукта не назвал: название не извлекается, и подбор идёт по
 * предметной области задачи.
 */
export function extractProductQuery(text: string): string | null {
  const lower = text.toLowerCase();
  if (UNKNOWN_PRODUCT_PATTERNS.some((pattern) => pattern.test(lower))) {
    return null;
  }

  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

  const meaningful = words.filter(
    (word) => !STOP_WORDS.has(word) && !/^\d+$/.test(word),
  );
  if (meaningful.length === 0) {
    return null;
  }
  // Одно-единственное слово из словаря запроса не считается названием.
  if (meaningful.length === 1 && words.length > 1) {
    return null;
  }
  return meaningful.join(" ");
}

/**
 * Извлекает вендора из сообщения.
 *
 * Вендор известен по списку вендоров каталога: иначе любое слово с большой
 * буквы считалось бы вендором. Сравнивается первое значимое слово названия:
 * в фиде вендор записан как «MDaemon Technologies, Ltd.», а клиент пишет
 * «MDaemon».
 */
export function extractVendor(text: string, vendors: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const vendor of vendors) {
    const vendorLower = vendor.toLowerCase();
    if (vendorLower.length < 3) continue;
    if (lower.includes(vendorLower)) {
      return vendor;
    }
    const head = vendorLower.split(/[\s,«»]+/u)[0] ?? vendorLower;
    if (head.length >= 4 && lower.includes(head)) {
      return vendor;
    }
  }
  return null;
}

/**
 * Извлекает слоты из текста сообщения.
 *
 * Количество и срок распознаются по числам рядом со словами-подсказками,
 * тип развёртывания — по прямым упоминаниям.
 */
export function extractSlots(text: string): RequirementSlots {
  const lower = text.toLowerCase();

  let termMonths: number | null = null;
  const termMatch = lower.match(/(\d+)\s*(?:месяц|мес|год|лет)/u);
  if (termMatch?.[1]) {
    const value = Number.parseInt(termMatch[1], 10);
    termMonths = lower.includes("год") || lower.includes("лет") ? value * 12 : value;
  }

  let quantity: number | null = null;
  // Количество — только рядом со словом про лицензии или пользователей:
  // «12 месяцев» — это срок, а не количество лицензий.
  const quantityMatch = lower.match(
    /(\d+)\s*(?:шт|штук|лицензи[йиюей]|польз[\p{L}\p{N}]*|работник[\p{L}\p{N}]*|сотрудник[\p{L}\p{N}]*|мест[\p{L}\p{N}]*|устройств[\p{L}\p{N}]*|пк)/u,
  );
  if (quantityMatch?.[1]) {
    quantity = Number.parseInt(quantityMatch[1], 10);
  }
  if (quantity === null) {
    // Голое число берётся, только если в тексте нет срока и бюджета: иначе
    // «12 месяцев» или «50000 рублей» превратились бы в количество.
    const bare = lower.match(/\b(\d{1,5})\b/u);
    if (bare?.[1] && termMonths === null && !/\s*руб|₽/u.test(lower)) {
      quantity = Number.parseInt(bare[1], 10);
    }
  }

  let deployment: string | null = null;
  if (/облак|cloud|в облаке/i.test(lower)) {
    deployment = "облако";
  } else if (
    /сервер|on-?prem|локальн|сво[яи]\s+(инфраструктур|сервер|парк)|инфраструктур[\p{L}\p{N}]*\s+(сво[яи]|собственн[\p{L}\p{N}]*|на\s+своем)|собственн[\p{L}\p{N}]*\s+(инфраструктур|сервер)|у\s+себя\s+на\s+сервер/iu.test(
      lower,
    )
  ) {
    // «Своя инфраструктура», «инфраструктура своя» и «у себя на сервере» —
    // это развёртывание на сервере заказчика. Без этого слот не
    // распознавался, и агент повторял один и тот же вопрос.
    deployment = "сервер";
  }

  // Бюджет: «бюджета нет», «нет бюджета» и «не ограничен» — это ответ, а не
  // отсутствие ответа. Без различения вопрос о бюджете повторялся бы.
  let budget: string | null = null;
  if (
    /бюджет[\p{L}\p{N}]*\s+(?:нет|не\s+огранич|без\s+огранич)|нет\s+бюджет|без\s+бюджета|бюджета\s+нет|не\s+ограничен|без\s+ограничени/iu.test(
      lower,
    )
  ) {
    budget = "нет";
  } else {
    const budgetMatch = lower.match(
      /(\d[\d\s ]*)\s*(?:руб|₽|тыс\.?\s*руб|р\.)/u,
    );
    if (budgetMatch?.[1]) {
      const digits = budgetMatch[1].replace(/[^\d]/g, "");
      if (digits.length > 0) {
        budget = String(Number.parseInt(digits, 10));
      }
    }
  }

  return {
    quantity,
    termMonths,
    deployment,
    vendor: null,
    budget,
    productQuery: null,
    // Режим подбора: клиент сказал, что не знает нужный продукт. Дальше
    // подбор идёт по предметной области задачи, даже когда ответ на
    // уточняющий вопрос содержит слова, похожие на название продукта.
    discovery: UNKNOWN_PRODUCT_PATTERNS.some((pattern) => pattern.test(lower))
      ? "подбор"
      : null,
    // Домен определяется по первому сообщению и сохраняется: ответ на
    // уточняющий вопрос уже не содержит признаков («бюджета нет,
    // инфраструктура своя»).
    domain: detectDomain(text),
  };
}

/** Параметр позиции каталога, приведённый к строке. */
function paramValue(params: Record<string, string | string[]>, names: string[]): string | null {
  for (const name of names) {
    const value = params[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return value.join(", ");
    } else {
      return value;
    }
  }
  return null;
}

/**
 * Количество лицензий позиции.
 *
 * Число берётся из параметров позиции («К-во пользователей»,
 * «Количество лицензий»), а при их отсутствии — из названия («на 50 ПК»,
 * «2 устройства»). Без этого позиция без параметров считалась подходящей под
 * любое количество, и в ответ попадали лицензии на одно устройство.
 *
 * Значение в фиде — диапазон («от 50 до 50»), поэтому берётся первое число:
 * «от 50 до 50» без разбора давало 5050, и подходящая позиция отсекалась.
 */
function licensedCount(item: CatalogItem): number | null {
  const fromParams = paramValue(item.params, [
    "К-во пользователей",
    "Количество лицензий",
    "Количество",
    "Лицензий",
  ]);
  if (fromParams !== null) {
    const number = firstNumber(fromParams);
    if (number !== null) return number;
  }

  const fromName = item.name.match(
    /(\d+)\s*(?:пк|пользовател|мест|устройств|лицензи)/iu,
  );
  if (fromName?.[1]) {
    const number = Number.parseInt(fromName[1], 10);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/** Первое число в строке: «от 50 до 50» → 50. */
function firstNumber(text: string): number | null {
  const match = text.match(/\d+/);
  if (!match?.[0]) return null;
  const number = Number.parseInt(match[0], 10);
  return Number.isFinite(number) ? number : null;
}

/**
 * Проверяет, закрывает ли позиция слот.
 *
 * Количество проверяется по параметрам позиции («К-во пользователей»,
 * «Количество лицензий») и по названию, срок — по «Срок действия»/«Срок
 * лицензии», развёртывание — по «Способ доставки». Если позиция не описывает
 * слот, он считается закрытым: это не то, чего агент должен уточнять, а то,
 * о чём позиция не сообщает вовсе.
 */
function slotSatisfied(
  slot: keyof RequirementSlots,
  item: CatalogItem,
  slots: RequirementSlots,
): boolean {
  switch (slot) {
    case "quantity": {
      if (slots.quantity === null) return false;
      const licensed = licensedCount(item);
      if (licensed === null) return true;
      return licensed >= slots.quantity;
    }
    case "termMonths": {
      if (slots.termMonths === null) return false;
      const term = paramValue(item.params, ["Срок действия", "Срок лицензии", "Срок", "Период"]);
      if (term === null) return true;
      const months = firstNumber(term);
      return months !== null ? months >= slots.termMonths : true;
    }
    case "deployment": {
      if (slots.deployment === null) return false;
      const delivery = paramValue(item.params, ["Способ доставки", "Тип поставки", "Поставка", "Тип"]);
      if (delivery === null) return true;
      const lower = delivery.toLowerCase();
      // Электронная поставка подходит любому развёртыванию: лицензия
      // приходит по почте, а не на сервер заказчика.
      if (/электронн/i.test(lower)) return true;
      const cloud = /облак|cloud/i.test(lower);
      const server = /сервер|on-?prem|локальн/i.test(lower);
      if (slots.deployment === "облако") return cloud;
      return server;
    }
    default:
      return true;
  }
}

/**
 * Ищет продукт в каталоге.
 *
 * Возвращает найденные позиции и список слотов, которые ещё нужно уточнить.
 * Пустой `productQuery` означает, что клиент не назвал продукт: по каталогу
 * ничего не ищем, но вендор и слоты из текста всё равно извлекаются.
 *
 * Название продукта берётся из сохранённого слота диалога, а при его
 * отсутствии — из текущего сообщения: ответ на уточняющий вопрос («нужно 10
 * штук») названия не содержит, и без сохранённого названия поиск по каталогу
 * не нашёл бы позицию. Порядок именно такой: продукт называют один раз, а
 * дальше уточняются параметры, и текст ответа на вопрос («на 12 месяцев,
 * развёртываем на сервере») не должен подменять название продукта.
 */
export async function lookupCatalog(
  text: string,
  slots: RequirementSlots,
  options: { tenantId: string; limit?: number; intent?: IntentClass },
): Promise<CatalogLookup> {
  // В режиме подбора продукт не назван: подбор идёт по предметной области
  // задачи, даже если ответ на уточняющий вопрос содержит слова, похожие на
  // название продукта («бюджета нет, инфраструктура своя»).
  const inDiscovery =
    options.intent === "product_unknown" ||
    slots.discovery !== null ||
    extractProductQuery(text) === null;
  const productQuery = inDiscovery
    ? slots.productQuery
    : slots.productQuery ?? extractProductQuery(text);
  const vendors = await listVendors(options.tenantId);
  // Вендор берётся из текста, а при его отсутствии — из сохранённого слота:
  // ответ на уточняющий вопрос («на 12 месяцев») вендора не содержит, и без
  // сохранённого вендора в выдачу подмешивались позиции других производителей
  // с похожим словом в названии.
  const vendor = extractVendor(text, vendors) ?? slots.vendor;
  const mergedSlots: RequirementSlots = { ...slots, vendor, productQuery };
  // Домен берётся из сохранённого слота: ответ на уточняющий вопрос уже не
  // содержит признаков домена.
  const domain = (slots.domain ?? detectDomain(text)) as CatalogDomain;

  // Клиент не назвал продукт: подбираем по предметной области задачи, а не
  // по словам запроса. Поиск по словам давал мусор — на «защитить почту»
  // находились «Защитный чехол с ремнем на плечо» и «Проектирование дорожных
  // знаков».
  if (productQuery === null) {
    const byDomain = await searchByDomain(domain, {
      tenantId: options.tenantId,
      vendor,
      limit: options.limit ?? 10,
      slots: mergedSlots,
    });
    // Варианты — по одному от каждого вендора: клиенту нужен выбор между
    // продуктами разных производителей, а не список номеров лицензий одного.
    const variants = distinctByVendor(byDomain);
    // В режиме подбора порядок вопросов другой: бюджет и инфраструктура
    // выясняются до подбора варианта.
    const filtered =
      variants.length > 0
        ? variants.filter(
            (match) => scoreBySlots(match, mergedSlots) === countFilledSlots(mergedSlots),
          )
        : variants;
    return {
      matches: filtered.length > 0 ? filtered : variants,
      productQuery: null,
      missingSlots: missingSlots(mergedSlots, "discovery"),
      domain,
      vendor,
    };
  }

  // Выборка шире итоговой: позиции, закрывающие собранные слоты, должны
  // попасть в ответ, а они могут быть дальше в порядке выдачи поиска.
  const FETCH_LIMIT = 50;

  const hits = await catalog.search(productQuery, {
    tenantId: options.tenantId,
    vendor: vendor ?? undefined,
    limit: FETCH_LIMIT,
  });

  const matches: CatalogMatch[] = [];
  for (const hit of hits) {
    const item = await catalog.getByOfferId(hit.offerId, { tenantId: options.tenantId });
    if (item === null) continue;
    matches.push(toMatch(item));
  }

  // Если клиент назвал вендор, показываются только его позиции: «нужен
  // MDaemon Security Gateway» — это про MDaemon, а «Security Gateway» в
  // названии встречается и у Dr.Web, и у Zoho.
  if (vendor !== null) {
    const ofVendor = matches.filter((match) => match.vendor === vendor);
    if (ofVendor.length > 0) {
      matches.length = 0;
      matches.push(...ofVendor);
    }
  }

  // Название найдено, но клиент описал задачу («защита почты»), а не назвал
  // продукт. Тогда поиск по словам даёт одну линейку вендора, а клиенту нужен
  // выбор: доменный отбор добавляет варианты других вендоров.
  //
  // Если клиент назвал вендора («нужен Dr.Web»), доменный отбор не
  // применяется: он подмешал бы другие вендоры к названному.
  if (domain !== null && matches.length > 0 && !namesVendor(text, matches)) {
    const byDomain = await searchByDomain(domain, {
      tenantId: options.tenantId,
      vendor: null,
      limit: FETCH_LIMIT,
      slots: mergedSlots,
    });
    for (const match of byDomain) {
      if (!matches.some((existing) => existing.offerId === match.offerId)) {
        matches.push(match);
      }
    }
  }

  // Если по запросу ничего не нашлось, ищем шире — без вендора.
  if (matches.length === 0 && vendor !== null) {
    const wide = await catalog.search(productQuery, {
      tenantId: options.tenantId,
      limit: FETCH_LIMIT,
    });
    for (const hit of wide) {
      const item = await catalog.getByOfferId(hit.offerId, { tenantId: options.tenantId });
      if (item === null) continue;
      matches.push(toMatch(item));
    }
  }

  const missing = missingSlots(mergedSlots);
  // Слоты проверяются по позициям: если позиция уже описывает нужный
  // параметр, уточнять его не нужно.
  if (matches.length > 0) {
    const satisfied: Record<string, boolean> = {};
    for (const slot of REQUIRED_SLOTS) {
      if (mergedSlots[slot] === null) continue;
      if (matches.some((match) => slotSatisfied(slot, match.item, mergedSlots))) {
        satisfied[slot] = true;
      }
    }
    const filtered = missing.filter((slot) => satisfied[slot] !== true);
    // Позиции, закрывающие собранные слоты, идут первыми: клиент спросил
    // про 50 лицензий, и первой должна быть позиция на 50, а не на 18.
    // Внутри группы порядок поиска каталога сохраняется: он отражает
    // релевантность запросу, и сортировка по цене перебивала бы её — на
    // запрос «MDaemon» первыми оказывались более дешёвые позиции Dr.Web.
    const order = new Map(matches.map((match, index) => [match.offerId, index]));
    const ordered = [...matches].sort((left, right) => {
      const leftScore = scoreBySlots(left, mergedSlots);
      const rightScore = scoreBySlots(right, mergedSlots);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return (order.get(left.offerId) ?? 0) - (order.get(right.offerId) ?? 0);
    });
    // В ответ идут позиции, подходящие под собранные слоты; неподходящие
    // остаются в выдаче только если подходящих нет.
    const fitting = ordered.filter(
      (match) => scoreBySlots(match, mergedSlots) === REQUIRED_SLOTS.length ||
        scoreBySlots(match, mergedSlots) === countFilledSlots(mergedSlots),
    );
    const chosen = fitting.length > 0 ? fitting : ordered;
    // Варианты — по одному от каждого вендора: клиенту нужен выбор между
    // продуктами разных производителей, а не список номеров лицензий одного.
    return {
      matches: distinctByVendor(chosen),
      productQuery,
      missingSlots: filtered,
      domain,
      vendor,
    };
  }

  return { matches, productQuery, missingSlots: missing, domain, vendor };
}

/**
 * Назван ли вендор в тексте запроса.
 *
 * Проверяется по вендорам найденных позиций: если клиент написал «нужен
 * Dr.Web», доменный отбор не применяется, иначе к названному вендору
 * подмешались бы другие.
 */
function namesVendor(text: string, matches: CatalogMatch[]): boolean {
  const lower = text.toLowerCase();
  return matches.some((match) => {
    if (match.vendor === null) return false;
    const vendor = match.vendor.toLowerCase();
    // Вендор в фиде длинный («MDaemon Technologies, Ltd.»), а клиент пишет
    // «MDaemon»: сравнивается первое значимое слово.
    const head = vendor.split(/[\s,«»]+/u)[0] ?? vendor;
    return head.length >= 3 && lower.includes(head);
  });
}

/**
 * Подбор позиций по предметной области задачи.
 *
 * Клиент не назвал продукт, поэтому искать по словам нечего: поиск по словам
 * находил всё, где встречается «защит». Вместо этого берутся категории фида
 * домена (для почты — «Интернет и Сеть», «Почтовые утилиты», «Почтовые
 * клиенты»), а внутри них — позиции с подтверждённой ценой и подходящим
 * количеством.
 *
 * Вендоры различаются: клиент спросил про защиту почты, а не про безопасность
 * вообще, поэтому вендоры вроде «Доктор Веб» (антивирусы) в почтовую
 * безопасность не попадают.
 */
async function searchByDomain(
  domain: CatalogDomain,
  options: {
    tenantId: string;
    vendor: string | null;
    limit: number;
    slots: RequirementSlots;
  },
): Promise<CatalogMatch[]> {
  const markers = domainCategoryMarkers(domain);
  if (markers === null) {
    return [];
  }

  // Бюджет ограничивает цену позиции: клиент назвал сумму, значит позиции
  // дороже не подходят. «Бюджета нет» ограничения не задаёт.
  const budgetLimit =
    options.slots.budget !== null && options.slots.budget !== "нет"
      ? Number.parseInt(options.slots.budget, 10)
      : null;
  const budgetIsNumber = budgetLimit !== null && Number.isFinite(budgetLimit);

  // Позиции домена берутся напрямую из категорий: полнотекстовый поиск по
  // названию здесь неприменим, названия вендоров не содержат слов запроса.
  //
  // Порядок параметров: $1 — арендатор, $2 — вендор, далее маркеры
  // категорий, последним — бюджет. Маркеры и бюджет не должны делить индекс:
  // при пересечении фильтр по категории не применялся, и в выдачу попадали
  // «Защитный чехол с ремнем на плечо» и «Проектирование дорожных знаков».
  const budgetIndex = markers.length + 3;
  const limitIndex = budgetIndex + 1;
  // Для домена почты одной категории мало: «Почтовые клиенты» и «Почтовые
  // утилиты» — это почта, а не почтовая защита. Поэтому домен почты ищется по
  // категории безопасности И признаку почты в самой позиции.
  const emailTermClause =
    domain === "email"
      ? `AND (lower(p.name) LIKE '%email%' OR lower(p.name) LIKE '%mail%'
             OR lower(p.name) LIKE '%antispam%' OR lower(p.name) LIKE '%антиспам%'
             OR lower(p.name) LIKE '%почт%' OR lower(p.name) LIKE '%шлюз%'
             OR lower(p.name) LIKE '%gateway%'
             OR lower(p.params::text) LIKE '%email%'
             OR lower(p.params::text) LIKE '%mail%'
             OR lower(p.params::text) LIKE '%почт%')`
      : "";
  // Количество фильтруется в самом запросе: «1 пользователь» не подходит
  // клиенту, которому нужны 50, а после выборки этот лицензионный вариант
  // оказывался первым.
  const quantityIndex = limitIndex + 1;
  const result = await getPool().query<{
    offer_id: string;
    name: string;
    vendor: string | null;
    price: string;
    category_path: string | null;
  }>(
    `SELECT p.offer_id, p.name, p.vendor, p.price, c.path AS category_path
       FROM products p
       JOIN catalog_snapshots s ON s.id = p.snapshot_id
       LEFT JOIN catalog_categories c
         ON c.tenant_id = p.tenant_id AND c.category_id = p.category_id
      WHERE p.tenant_id = $1
        AND p.price > 0
        AND ($2::text IS NULL OR p.vendor = $2)
        AND (${markers
          .map((_marker, index) => `lower(c.path) LIKE '%' || lower($${index + 3}) || '%'`)
          .join(" OR ")})
        ${emailTermClause}
        AND ($${budgetIndex}::numeric IS NULL OR p.price <= $${budgetIndex})
        AND ($${quantityIndex}::integer IS NULL
             OR COALESCE((regexp_match(p.params->>'К-во пользователей', '[0-9]+'))[1]::integer, 0) >= $${quantityIndex})
      ORDER BY
        (CASE WHEN p.params->>'К-во пользователей' IS NULL THEN 0 ELSE 1 END) DESC,
        p.price
      LIMIT $${limitIndex}`,
    [
      options.tenantId,
      options.vendor,
      ...markers,
      budgetIsNumber ? budgetLimit : null,
      options.limit,
      options.slots.quantity,
    ],
  );
  const matches: CatalogMatch[] = [];
  for (const row of result.rows) {
    const item = await catalog.getByOfferId(row.offer_id, {
      tenantId: options.tenantId,
    });
    if (item === null) continue;
    matches.push(toMatch(item));
  }
  return matches;
}

/**
 * Варианты для ответа: не более одной позиции от каждого вендора.
 *
 * Без этого в выдаче оказывались десять позиций одного вендора — клиенту
 * показывался не выбор, а список номеров лицензий одного продукта. Вендоры
 * здесь и есть варианты: Dr.Web, Kaspersky, MDaemon.
 */
function distinctByVendor(matches: CatalogMatch[]): CatalogMatch[] {
  const seenVendors: Record<string, boolean> = {};
  const result: CatalogMatch[] = [];
  for (const match of matches) {
    const vendor = match.vendor ?? match.offerId;
    if (seenVendors[vendor] === true) continue;
    seenVendors[vendor] = true;
    result.push(match);
  }
  return result;
}
/** Число слотов, по которым собраны данные. */
function countFilledSlots(slots: RequirementSlots): number {
  return REQUIRED_SLOTS.filter((slot) => slots[slot] !== null).length;
}

/**
 * Число слотов, которым соответствует позиция.
 *
 * Позиция, у которой параметр совпадает с собранным слотом, релевантнее:
 * клиент спросил про 50 лицензий, и позиция на 50 подходит, а позиция на 18 —
 * нет. Бюджет в счёт не входит: он ограничивает цену, а не свойство позиции.
 */
function scoreBySlots(match: CatalogMatch, slots: RequirementSlots): number {
  let score = 0;
  for (const slot of REQUIRED_SLOTS) {
    if (slots[slot] === null) continue;
    if (slotSatisfied(slot, match.item, slots)) score += 1;
  }
  return score;
}

/**
 * Слоты, которые ещё не закрыты.
 *
 * Порядок вопросов зависит от режима: для известного продукта уточняются
 * параметры лицензии (количество, срок, развёртывание), для подбора по
 * задаче — сначала бюджет и инфраструктура. Порядок разный, потому что в
 * первом случае продукт уже известен, а во втором — ещё нет.
 */
export function missingSlots(
  slots: RequirementSlots,
  mode: "known" | "discovery" = "known",
): Array<keyof RequirementSlots> {
  const order = mode === "known" ? REQUIRED_SLOTS : DISCOVERY_SLOTS;
  return order.filter((slot) => slots[slot] === null);
}

/** Позиция каталога в виде, пригодном для ответа. */
function toMatch(item: CatalogItem): CatalogMatch {
  const parsed = parseProductName(item.name, item.vendor);
  return {
    offerId: item.offerId,
    name: parsed.name,
    vendor: item.vendor,
    edition: parsed.edition,
    price: item.price,
    currency: item.currencyId,
    available: item.available,
    priceConfirmed: item.priceConfirmed,
    feedDate: item.feedDate,
    snapshotHash: item.snapshotHash,
    url: item.productUrl,
    params: item.params,
    item,
  };
}

/**
 * Вендоры каталога — по ним узнаётся вендор в сообщении клиента.
 *
 * Список не ограничен: в фиде 1237 вендоров, и ограничение в 200 отсекало
 * MDaemon, из-за чего клиентский запрос «нужен MDaemon» не распознавался как
 * запрос конкретного вендора и в ответ попадали позиции других производителей.
 */
async function listVendors(tenantId: string): Promise<string[]> {
  const result = await getPool().query<{ vendor: string }>(
    `SELECT DISTINCT vendor FROM products
      WHERE tenant_id = $1 AND vendor IS NOT NULL AND vendor <> ''
      ORDER BY vendor`,
    [tenantId],
  );
  return result.rows.map((row) => row.vendor);
}

/**
 * Текст позиции каталога для проверки и цитирования.
 *
 * Цена и наличие помечены как взятые из снимка фида: это не подтверждённый
 * в реальном времени остаток, и клиент должен это понимать.
 */
export function catalogMatchText(match: CatalogMatch): string {
  const lines = [
    match.name,
    match.vendor === null ? "" : `Вендор: ${match.vendor}`,
    `Цена: ${formatPrice(match.price, match.currency)}`,
    match.available ? "Наличие по снимку фида: есть" : "Наличие по снимку фида: не указано",
    `Снимок фида: ${match.feedDate}`,
    match.url === null ? "" : `Карточка: ${match.url}`,
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}

/** Цена позиции в виде, пригодном для показа. */
export function formatPrice(price: number, currency: string): string {
  if (!Number.isFinite(price) || price <= 0) {
    return "цена не подтверждена";
  }
  const amount = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 2,
  }).format(price);
  return currency === "RUR" ? `${amount} ₽` : `${amount} ${currency}`;
}

/**
 * Количество лицензий позиции — для показа отдельным полем.
 *
 * В названии фида количество вклеено в наименование («…, 50»), и в ответе
 * это читалось как часть названия. Количество показывается отдельной строкой.
 */
export function licensedCountText(match: CatalogMatch): string | null {
  const count = licensedCount(match.item);
  return count === null ? null : `${count} польз.`;
}

/**
 * Строка позиции для ответа: название, вендор, редакция, количество, цена.
 *
 * Поля разнесены по местам, а не склеены в одну строку: на демо «Ltd.
 * Netwin SurgeMail» и «Веб Dr.Web» читались как обрывки названия.
 */
export function catalogLine(match: CatalogMatch): string {
  const parts: string[] = [match.name];
  if (match.vendor !== null) parts.push(match.vendor);
  if (match.edition !== null) parts.push(match.edition);
  const count = licensedCountText(match);
  if (count !== null) parts.push(count);
  parts.push(formatPrice(match.price, match.currency));
  return parts.join(", ");
}

/**
 * Краткий перечень позиций — для сопровождения уточняющего вопроса.
 *
 * Показываются только те позиции, по которым клиент уже может сориентироваться:
 * название и цена из снимка фида.
 */
export function catalogSummary(matches: CatalogMatch[]): string {
  const lines = matches.slice(0, 3).map((match) => `— ${catalogLine(match)}`);
  if (lines.length === 0) return "";
  return `Похожие позиции в фиде:\n${lines.join("\n")}`;
}

/**
 * Ответ по найденным позициям каталога.
 *
 * Формат по ADR-0014: сначала прямой ответ, затем позиции с ценой из снимка
 * фида, в конце ссылка на карточку. Суммы берутся из карточки каталога, а не
 * из ответа модели, поэтому модель не может назвать другую цену.
 *
 * Название позиции очищается от вклеенного количества, вендор и количество
 * показываются отдельными полями: в названии фида они дублируются, а в ответе
 * это выглядело как «…, 6: 18 516 ₽» без разделителя.
 */
export function catalogAnswer(
  matches: CatalogMatch[],
  productQuery: string | null,
): string {
  const chosen = matches.slice(0, 3);
  const subject =
    productQuery === null
      ? "по вашей задаче"
      : `по запросу «${productQuery}»`;

  const lines: string[] = [];
  lines.push(
    `По фиду нашёл ${chosen.length} ${chosen.length === 1 ? "позицию" : "позиции"} ${subject}.`,
  );
  lines.push("");
  chosen.forEach((match, index) => {
    lines.push(`${index + 1}. ${catalogLine(match)}`);
  });
  lines.push("");
  lines.push("Цены и наличие взяты из снимка фида, а не подтверждены в реальном времени.");
  // Ссылка на карточку в текст ответа не попадает: она остаётся в
  // источниках ответа, в трассе и в кабинете менеджера.
  return lines.join("\n");
}
