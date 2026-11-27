/**
 * Определение предметной области подбора по каталогу.
 *
 * Поиск по словам названия даёт мусор: на запрос «защитить почту на 50
 * сотрудников» находились «Проектирование дорожных знаков», «замена функций
 * защиты от несанкционированного доступа» и «Защитный чехол с ремнем на
 * плечо» — всё, где встречается слово «защит».
 *
 * Поэтому запрос переводится в домен, а домен — в маркеры категорий фида.
 * Позиция подходит, если её категория относится к домену: «Торговое
 * оборудование / POS-аксессуары» к почтовой безопасности отношения не имеет.
 */

/** Домены подбора, которые различаются в каталоге. */
export type CatalogDomain = "email" | "security" | "office" | null;

/**
 * Маркеры категорий фида по доменам.
 *
 * Совпадение ищется по полному пути категории (`catalog_categories.path`),
 * поэтому учитываются и родительские категории: «Антивирусы и безопасность /
 * Интернет и Сеть» подходит и под почту, и под безопасность.
 */
const DOMAIN_CATEGORY_MARKERS: Record<Exclude<CatalogDomain, null>, string[]> = {
  // Почтовая безопасность лежит в категориях безопасности, а не в «Почтовых
  // клиентах» и «Почтовых утилитах» — это почта, а не защита почты. Маркер
  // категории поэтому широкий по безопасности, а узкий отбор делает признак
  // email в самой позиции (см. `isEmailSecurityProduct`).
  email: ["антивирус", "безопасност", "защит", "шлюз", "интернет", "сеть"],
  security: [
    "антивирус",
    "безопасност",
    "защит",
    "шифрован",
    "межсетев",
    "аутентиф",
  ],
  office: ["офис", "office", "документ", "текст", "таблиц", "презентац"],
};

/**
 * Признаки email-безопасности в названии и параметрах позиции.
 *
 * Категории фида для почты — «Почтовые клиенты» и «Почтовые утилиты», а
 * почтовая защита (MDaemon, Clearswift, F-Secure) лежит в категории
 * «Интернет и Сеть». Поэтому домен определяется по двум признакам сразу:
 * категория безопасности И признак почты в самой позиции.
 */
const EMAIL_SECURITY_TERMS = [
  "email",
  "e-mail",
  "mail",
  "антиспам",
  "antispam",
  "smtp",
  "imap",
  "почт",
  "шлюз",
  "gateway",
];

/**
 * Является ли позиция почтовой защитой.
 *
 * Проверяются название и параметры позиции: у MDaemon это «Security Gateway
 * for Email Servers», у Dr.Web — «Комплексная защита + Центр управления» с
 * параметром про почту.
 */
export function isEmailSecurityProduct(name: string, params: Record<string, unknown>): boolean {
  const haystack = `${name} ${JSON.stringify(params)}`.toLowerCase();
  return EMAIL_SECURITY_TERMS.some((term) => haystack.includes(term));
}

/**
 * Маркеры категорий фида для домена.
 *
 * Возвращает `null` для домена без маркеров: ограничения по категории нет.
 */
export function domainCategoryMarkers(domain: CatalogDomain): string[] | null {
  if (domain === null) return null;
  return DOMAIN_CATEGORY_MARKERS[domain];
}

/** Слова запроса, по которым определяется домен. */
const DOMAIN_KEYWORDS: Record<Exclude<CatalogDomain, null>, string[]> = {
  email: ["почт", "email", "e-mail", "письм", "спам", "антиспам", "рассылк"],
  security: [
    "защит",
    "антивирус",
    "безопасн",
    "шифрован",
    "аутентиф",
    "вредонос",
    "шпионск",
    "Firewall",
    "межсетев",
  ],
  office: ["документ", "офис", "excel", "word", "таблиц", "презентац", "pdf"],
};

/**
 * Домен по тексту запроса.
 *
 * Домен определяется по большему числу совпадений: «защитить почту» даёт и
 * «защит» (security), и «почт» (email), но «почта» — более узкий признак
 * задачи, поэтому при равенстве побеждает домен с более узким маркером.
 */
export function detectDomain(text: string): CatalogDomain {
  const lower = text.toLowerCase();
  const scores: Record<Exclude<CatalogDomain, null>, number> = {
    email: 0,
    security: 0,
    office: 0,
  };

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as Array<
    [Exclude<CatalogDomain, null>, string[]]
  >) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) scores[domain] += 1;
    }
  }

  const ranked = (Object.entries(scores) as Array<[Exclude<CatalogDomain, null>, number]>)
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1]);
  const best = ranked[0];
  if (best === undefined) {
    return null;
  }
  // При равенстве побеждает более узкий домен: «почта» — про почту, а не про
  // безопасность вообще.
  if (ranked[1] !== undefined && ranked[1][1] === best[1] && best[0] === "security") {
    return ranked[1][0];
  }
  return best[0];
}

/**
 * Подходит ли категория домену.
 *
 * Путь категории сопоставляется с маркерами домена целиком либо по родителю:
 * подкатегория наследует домен родителя.
 */
export function categoryMatchesDomain(
  categoryPath: string | null,
  domain: CatalogDomain,
): boolean {
  if (domain === null) return true;
  if (categoryPath === null) return true;
  const lower = categoryPath.toLowerCase();
  return DOMAIN_CATEGORY_MARKERS[domain].some((marker) => lower.includes(marker));
}
