/**
 * Маскирование персональных данных (R14).
 *
 * Поддерживаемые классы: ФИО/имя, организация, адрес, телефон, email, ИНН,
 * банковские и паспортные реквизиты. Модель получает только метки вида
 * ⟦PERSON_1⟧; таблица соответствий остаётся в серверной части и наружу
 * (в модель, в трассу, в логи) не попадает.
 */

export type MaskClass =
  | "PERSON"
  | "ORG"
  | "ADDRESS"
  | "PHONE"
  | "EMAIL"
  | "INN"
  | "BANK"
  | "PASSPORT";

/** Метка → исходное значение. Хранится только на сервере. */
export type MaskMapping = Record<string, string>;

/** Состояние маскирования в рамках диалога. */
export type MaskScope = {
  /** Уже накопленные соответствия диалога: метка → исходное значение. */
  mapping?: MaskMapping;
};

export type MaskResult = {
  maskedText: string;
  mapping: MaskMapping;
  maskedFieldsCount: number;
};

type Rule = {
  kind: MaskClass;
  pattern: RegExp;
  /** Индекс группы, если заменяется не весь матч, а его часть. */
  group?: number;
};

/**
 * Порядок правил важен: сначала самые специфичные и самые длинные значения
 * (email, банковские реквизиты), затем адрес и организация, и только потом
 * ФИО — иначе внутри счёта или адреса нашлись бы «телефон» или «имя».
 *
 * Границы слова заданы через Unicode-свойства: `\b` в JavaScript опирается
 * на ASCII-класс `\w`, поэтому на кириллице он не работает — «Иванов» не
 * начинается «границей слова».
 *
 * У всех правил обязателен флаг `g`: без него `exec` не продвигает курсор
 * и повторный поиск зацикливается.
 */
/**
 * Слова, которые в русском тексте стоят с заглавной буквы, но не являются
 * именами: «Как», «Нужна», «Электронная» в начале предложения.
 *
 * Без этого списка правило одноимённого маскирования склеило бы обычные
 * слова в метки и сломало бы поиск по БЗ.
 */
const NOT_A_NAME = new Set([
  "а",
  "без",
  "в",
  "весь",
  "вот",
  "все",
  "всего",
  "вы",
  "где",
  "да",
  "для",
  "до",
  "его",
  "ее",
  "её",
  "если",
  "есть",
  "же",
  "за",
  "здесь",
  "и",
  "из",
  "или",
  "им",
  "их",
  "к",
  "как",
  "какая",
  "какой",
  "когда",
  "кто",
  "ли",
  "может",
  "можно",
  "мои",
  "мы",
  "на",
  "надо",
  "наш",
  "не",
  "нет",
  "ни",
  "но",
  "нужно",
  "о",
  "об",
  "он",
  "она",
  "они",
  "оно",
  "от",
  "перед",
  "по",
  "под",
  "после",
  "при",
  "про",
  "с",
  "скажите",
  "так",
  "также",
  "то",
  "тоже",
  "той",
  "том",
  "ты",
  "у",
  "хотя",
  "хочу",
  "чего",
  "чем",
  "что",
  "чтобы",
  "чуть",
  "эта",
  "эти",
  "это",
  "этого",
  "я",
]);

const RULES: Rule[] = [
  {
    kind: "EMAIL",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/dgi,
  },
  {
    kind: "BANK",
    pattern: /(?<![\p{L}\p{N}])\d{20}(?![\p{L}\p{N}])/dug,
  },
  {
    kind: "BANK",
    pattern: /(?<![\p{L}\p{N}])\d{16}(?![\p{L}\p{N}])/dug,
  },
  {
    kind: "PASSPORT",
    pattern: /(?<![\p{L}\p{N}])паспорт(?![\p{L}\p{N}])[^0-9\n]{0,30}(\d[\d\s-]{8,17}\d)(?![\p{L}\p{N}])/dugi,
    group: 1,
  },
  {
    kind: "INN",
    pattern: /(?<![\p{L}\p{N}])ИНН(?![\p{L}\p{N}])[^0-9\n]{0,30}(\d{10,12})(?![\p{L}\p{N}])/dugi,
    group: 1,
  },
  {
    kind: "ADDRESS",
    pattern:
      /(?<![\p{L}\p{N}])(?:адрес|адр\.)(?![\p{L}\p{N}])[\s:]*[^\n,;]{2,60}(?:,\s*(?:д|дом|стр|корп|кв|оф)\.?\s*[^\n,;]{1,20})*/dugi,
  },
  {
    kind: "ADDRESS",
    pattern:
      /(?<![\p{L}\p{N}])(?:ул\.|улица|проспект|пр-т|переулок|пер\.|шоссе|бульвар|б-р|набережная|наб\.|пл\.|площадь)\s+[^\n,;]{1,60}(?:,\s*(?:д|дом|стр|корп|кв|оф)\.?\s*[^\n,;]{1,20})*/dugi,
  },
  {
    kind: "ORG",
    pattern: /(?<![\p{L}\p{N}])(?:ООО|ПАО|АО|ЗАО|ОАО|ИП|НАО|ЧОУ|ДОУ|ГУП|МУП|ФГУП)\s+«[^»]{1,80}»/dug,
  },
  {
    kind: "ORG",
    pattern: /(?<![\p{L}\p{N}])(?:ООО|ПАО|АО|ЗАО|ОАО|ИП|НАО|ЧОУ|ДОУ|ГУП|МУП|ФГУП)\s+[А-ЯЁ][^,.;\n]{1,60}/dug,
  },
  {
    kind: "PHONE",
    pattern: /(?<=телефон[\s:]*)(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/dgiu,
  },
  {
    kind: "PHONE",
    pattern: /(?<![\p{L}\p{N}])(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?![\p{L}\p{N}])/dug,
  },
  {
    kind: "PERSON",
    pattern: /(?<![\p{L}\p{N}])[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}(?![\p{L}\p{N}])/dug,
  },
  {
    // Одно имя: «Иван из ООО», «для Иванова». Слово должно стоять в
    // именной позиции — рядом с предлогом или частицей, — иначе обычные
    // слова в начале фразы («Электронная лицензия») были бы помечены.
    kind: "PERSON",
    pattern:
      /(?<![\p{L}\p{N}])(?:для|от|у|с|к|до|за|по)\s+([А-ЯЁ][а-яё]+)(?![\p{L}\p{N}])/dugi,
    group: 1,
  },
  {
    kind: "PERSON",
    pattern:
      /(?<![\p{L}\p{N}])([А-ЯЁ][а-яё]+)(?=\s+(?:из|от|для|у|с)(?![\p{L}\p{N}]))/dugi,
    group: 1,
  },
];

/** Ключ дедупликации: класс плюс нормализованное значение. */
function dedupKey(kind: MaskClass, value: string): string {
  if (kind === "EMAIL") return `${kind}:${value.toLowerCase()}`;
  if (kind === "PHONE" || kind === "INN" || kind === "BANK" || kind === "PASSPORT") {
    return `${kind}:${value.replace(/\D/g, "")}`;
  }
  return `${kind}:${value.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** Счётчики меток по классам: восстанавливаются из накопленной таблицы. */
function countersFrom(mapping: MaskMapping): Record<MaskClass, number> {
  const counters: Record<MaskClass, number> = {
    PERSON: 0,
    ORG: 0,
    ADDRESS: 0,
    PHONE: 0,
    EMAIL: 0,
    INN: 0,
    BANK: 0,
    PASSPORT: 0,
  };
  for (const label of Object.keys(mapping)) {
    const match = /^⟦([A-Z]+)_(\d+)⟧$/.exec(label);
    if (!match) continue;
    const kind = match[1] as MaskClass;
    const index = Number(match[2]);
    counters[kind] = Math.max(counters[kind] ?? 0, index);
  }
  return counters;
}

export function maskPersonalData(text: string, scope: MaskScope = {}): MaskResult {
  const mapping: MaskMapping = { ...(scope.mapping ?? {}) };
  const counters = countersFrom(mapping);

  // Значение → метка: одно и то же значение получает одну метку.
  const labelByValue = new Map<string, string>();
  for (const [label, value] of Object.entries(mapping)) {
    const kind = /^⟦([A-Z]+)_\d+⟧$/.exec(label)?.[1] as MaskClass | undefined;
    if (!kind) continue;
    labelByValue.set(dedupKey(kind, value), label);
  }

  let maskedFieldsCount = 0;
  let maskedText = text;

  for (const rule of RULES) {
    const matches: Array<{ start: number; end: number; value: string }> = [];
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match = pattern.exec(maskedText);
    while (match !== null) {
      const indices = match.indices?.[rule.group ?? 0];
      if (indices) {
        matches.push({
          start: indices[0],
          end: indices[1],
          value: maskedText.slice(indices[0], indices[1]),
        });
      }
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(maskedText);
    }

    // Заменяем справа налево, чтобы смещения не «поехали».
    for (const hit of matches.reverse()) {
      // Обычные слова с заглавной буквы именами не являются.
      if (
        rule.kind === "PERSON" &&
        NOT_A_NAME.has(hit.value.toLowerCase())
      ) {
        continue;
      }

      const key = dedupKey(rule.kind, hit.value);
      let label = labelByValue.get(key);
      if (!label) {
        counters[rule.kind] += 1;
        label = `⟦${rule.kind}_${counters[rule.kind]}⟧`;
        mapping[label] = hit.value;
        labelByValue.set(key, label);
        maskedFieldsCount += 1;
      }
      maskedText = maskedText.slice(0, hit.start) + label + maskedText.slice(hit.end);
    }
  }

  return { maskedText, mapping, maskedFieldsCount };
}

export function restoreMaskedData(text: string, mapping: MaskMapping): string {
  return text.replace(/⟦[A-Z]+_\d+⟧/g, (label) => mapping[label] ?? label);
}

/**
 * Классы ПД, найденные в тексте без маскирования.
 *
 * Используется валидатором исходящего текста: те же шаблоны, что и у
 * маскировщика, поэтому утечка отсекается тем же набором правил.
 */
export function findRawPersonalData(text: string): MaskClass[] {
  const found = new Set<MaskClass>();
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const match = pattern.exec(text);
    if (match !== null) found.add(rule.kind);
  }
  return [...found];
}

/**
 * Значения ПД, найденные в тексте без маскирования.
 *
 * Нужны для проверки исходящего текста: значение, совпадающее с уже
 * известным (например, восстановленным по таблице соответствий), — не
 * утечка; любое другое значение — утечка.
 */
export function findRawPersonalDataValues(text: string): string[] {
  const found: string[] = [];
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match = pattern.exec(text);
    while (match !== null) {
      const indices = match.indices?.[rule.group ?? 0];
      if (indices) {
        const value = text.slice(indices[0], indices[1]).trim();
        if (value) found.push(value);
      }
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }
  return found;
}
