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
   * Название продукта, как его понял агент.
   *
   * Хранится в диалоге: ответ клиента на уточняющий вопрос («нужно 10 штук»)
   * названия продукта не содержит, и без сохранённого названия поиск по
   * каталогу не нашёл бы позицию.
   */
  productQuery: string | null;
};

/** Слоты, которые нужно уточнить: порядок соответствует порядку вопросов. */
export const REQUIRED_SLOTS: Array<keyof RequirementSlots> = [
  "quantity",
  "termMonths",
  "deployment",
];

/** Вопросы по слотам — задаются по одному. */
export const SLOT_QUESTIONS: Record<keyof RequirementSlots, string> = {
  quantity: "Сколько лицензий (или пользователей) нужно?",
  termMonths: "На какой срок нужна лицензия — 12 месяцев или больше?",
  deployment: "Как разворачиваем — на сервере заказчика или в облаке?",
  vendor: "Какого вендора рассматриваете?",
  productQuery: "Какой продукт вас интересует?",
};

/** Найденная позиция каталога вместе с данными для ответа. */
export type CatalogMatch = {
  offerId: string;
  name: string;
  vendor: string | null;
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
 * Извлекает название продукта из сообщения.
 *
 * Из текста убираются слова запроса и служебные слова; остаток считается
 * названием продукта. Пустой остаток означает, что клиент назвал продукт
 * неявно («сколько стоит?») — тогда каталог не ищется по имени.
 */
export function extractProductQuery(text: string): string | null {
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
 * буквы считалось бы вендором.
 */
export function extractVendor(text: string, vendors: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const vendor of vendors) {
    const vendorLower = vendor.toLowerCase();
    if (vendorLower.length < 3) continue;
    if (lower.includes(vendorLower)) {
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
    /(\d+)\s*(?:шт|штук|лицензи[йиюей]|польз\w*|работник\w*|сотрудник\w*|мест\w*|устройств\w*|пк)/u,
  );
  if (quantityMatch?.[1]) {
    quantity = Number.parseInt(quantityMatch[1], 10);
  }
  if (quantity === null) {
    // Голое число берётся, только если в тексте нет срока: иначе «12 месяцев»
    // превратилось бы в количество 12.
    const bare = lower.match(/\b(\d{1,5})\b/u);
    if (bare?.[1] && termMonths === null) {
      quantity = Number.parseInt(bare[1], 10);
    }
  }

  let deployment: string | null = null;
  if (/облак|cloud|в облаке/i.test(lower)) {
    deployment = "облако";
  } else if (/сервер|on-?prem|локальн/i.test(lower)) {
    deployment = "сервер";
  }

  // Название продукта здесь не вычисляется: оно выводится из текста в
  // `lookupCatalog` и сохраняется в диалоге только когда каталог действительно
  // нашёл позицию. Иначе обычное слово («привет») стало бы названием продукта.
  return { quantity, termMonths, deployment, vendor: null, productQuery: null };
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
  options: { tenantId: string; limit?: number } ,
): Promise<CatalogLookup> {
  const productQuery = slots.productQuery ?? extractProductQuery(text);
  const vendors = await listVendors(options.tenantId);
  const vendor = extractVendor(text, vendors);
  const mergedSlots: RequirementSlots = { ...slots, vendor, productQuery };

  if (productQuery === null) {
    return { matches: [], productQuery: null, missingSlots: missingSlots(mergedSlots) };
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
    return {
      matches: fitting.length > 0 ? fitting : ordered,
      productQuery,
      missingSlots: filtered,
    };
  }

  return { matches, productQuery, missingSlots: missing };
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
 * нет.
 */
function scoreBySlots(match: CatalogMatch, slots: RequirementSlots): number {
  let score = 0;
  for (const slot of REQUIRED_SLOTS) {
    if (slots[slot] === null) continue;
    if (slotSatisfied(slot, match.item, slots)) score += 1;
  }
  return score;
}

/** Слоты, которые ещё не закрыты. */
export function missingSlots(slots: RequirementSlots): Array<keyof RequirementSlots> {
  return REQUIRED_SLOTS.filter((slot) => slots[slot] === null);
}

/** Позиция каталога в виде, пригодном для ответа. */
function toMatch(item: CatalogItem): CatalogMatch {
  return {
    offerId: item.offerId,
    name: item.name,
    vendor: item.vendor,
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

/** Вендоры каталога — по ним узнаётся вендор в сообщении клиента. */
async function listVendors(tenantId: string): Promise<string[]> {
  const result = await getPool().query<{ vendor: string }>(
    `SELECT DISTINCT vendor FROM products
      WHERE tenant_id = $1 AND vendor IS NOT NULL AND vendor <> ''
      ORDER BY vendor
      LIMIT 200`,
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
 * Краткий перечень позиций — для сопровождения уточняющего вопроса.
 *
 * Показываются только те позиции, по которым клиент уже может сориентироваться:
 * название и цена из снимка фида.
 */
export function catalogSummary(matches: CatalogMatch[]): string {
  const lines = matches.slice(0, 3).map(
    (match) => `— ${match.name}: ${formatPrice(match.price, match.currency)}`,
  );
  if (lines.length === 0) return "";
  return `Похожие позиции в фиде:\n${lines.join("\n")}`;
}

/**
 * Ответ по найденным позициям каталога.
 *
 * Формат по ADR-0014: сначала прямой ответ, затем позиции с ценой из снимка
 * фида, в конце ссылка на карточку. Суммы берутся из карточки каталога, а не
 * из ответа модели, поэтому модель не может назвать другую цену.
 */
export function catalogAnswer(
  matches: CatalogMatch[],
  productQuery: string | null,
): string {
  const chosen = matches.slice(0, 3);
  const subject = productQuery === null ? "подходящие позиции" : `«${productQuery}»`;

  const lines: string[] = [];
  lines.push(
    `По фиду нашёл ${chosen.length} ${chosen.length === 1 ? "позицию" : "позиции"} по запросу ${subject}.`,
  );
  lines.push("");
  chosen.forEach((match, index) => {
    lines.push(
      `${index + 1}. ${match.name} — ${formatPrice(match.price, match.currency)}${
        match.vendor === null ? "" : `, ${match.vendor}`
      }`,
    );
  });
  lines.push("");
  lines.push("Цены и наличие взяты из снимка фида, а не подтверждены в реальном времени.");
  const url = chosen.find((match) => match.url !== null)?.url;
  if (url !== undefined && url !== null) {
    lines.push(`Карточка: ${url}`);
  }
  return lines.join("\n");
}
