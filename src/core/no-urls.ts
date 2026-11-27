/**
 * Ссылки в клиентском чате.
 *
 * Ссылки на источники нужны менеджеру и остаются в `answer.sources`, в
 * трассе и в кабинете. В тексте ответа клиенту их нет: чат — это переписка
 * поддержки, а не список адресов, и URL в тексте выглядят как спам и мешают
 * читать ответ.
 *
 * Модель может вставить ссылку сама, поэтому из готового текста они
 * вычищаются: правило действует на любой источник текста, а не только на
 * модельный.
 */

/** URL в тексте ответа. */
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'«»]+/giu;

/**
 * Ссылка без схемы: `softline.ru/product/123`.
 *
 * Правило ADR-0014 действует на любой текст, а не только на подмножество со
 * схемой: модель пишет и «softline.ru/product/123», и такой адрес уходил
 * клиенту.
 *
 * Домен состоит из метки и домена верхнего уровня из закрытого списка:
 * произвольное слово с точкой («т.е.», «стр. 5») адресом не считается.
 */
const SCHEMELESS_URL_PATTERN =
  /(?<![\p{L}\p{N}@.-])[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.(?:ru|com|org|net|io|info|co|рф)(?:\/[^\s<>()[\]"'«»]*)?/giu;

/** Почтовая ссылка: `mailto:someone@example.com`. */
const MAILTO_PATTERN = /mailto:[^\s<>()[\]"'«»]+/giu;

/** Ссылка с markdown-разметки: `[текст](адрес)` → `текст`. */
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/giu;

/**
 * Служебные маркеры источников в тексте ответа.
 *
 * Модель может дописать «Источник: [1]» или «по данным источника [2]»,
 * хотя промпт это запрещает. Клиент не должен видеть, как устроена система
 * изнутри: ссылка на материал остаётся в `answer.sources`, в трассе и в
 * кабинете менеджера (решение владельца от 27.11.2026).
 */
const SOURCE_MARKER_PATTERNS: RegExp[] = [
  // «Источник: [1]», «Источники: [1], [2]» — отдельная строка.
  /^[ \t]*(?:Источник|Источники)\s*:\s*\[[\d,\s]+\][ \t]*$/gimu,
  // «Источник [1]» без двоеточия.
  /^[ \t]*(?:Источник|Источники)\s*\[[\d,\s]+\][ \t]*$/gimu,
  // «в источниках», «по данным источника» — в середине текста.
  //
  // Границы слов заданы через lookaround, а не через `\b`: `\b` опирается на
  // ASCII-класс `\w` и с кириллицей не работает.
  /(?<![\p{L}\p{N}])(?:в|из|по|на)\s+(?:пере)?данных\s+источников?(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])в\s+источниках(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])из\s+источников(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])по\s+источникам(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])источник(?:а|и|ов)?\s+\[\d+(?:\s*,\s*\d+)*\](?![\p{L}\p{N}])/giu,
  // «в переданных материалах», «в полученных данных» — тоже внутренности.
  /(?<![\p{L}\p{N}])(?:в|из|по)\s+(?:переданных\s+|полученных\s+|переданном\s+)?(?:материалах|материале|данных)(?![\p{L}\p{N}])/giu,
];

/**
 * Убирает служебные маркеры источников из текста ответа клиенту.
 *
 * Применяется к любому тексту, а не только к модельному: строка про источник
 * может прийти и из шаблона ответа.
 */
export function stripSourceMarkers(text: string): string {
  let cleaned = text;
  for (const pattern of SOURCE_MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Убирает ссылки из текста ответа клиенту.
 *
 * Ссылка с текстом заменяется её текстом, голая ссылка удаляется. Двойные
 * пробелы и пробелы в конце строки убираются, чтобы текст не выглядел
 * разорванным.
 */
export function stripUrls(text: string): string {
  const withoutMarkdown = text.replace(MARKDOWN_LINK_PATTERN, "$1");
  const withoutUrls = withoutMarkdown.replace(URL_PATTERN, "");
  const withoutMailto = withoutUrls.replace(MAILTO_PATTERN, "");
  const withoutSchemeless = withoutMailto.replace(SCHEMELESS_URL_PATTERN, "");
  return withoutSchemeless
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Есть ли в тексте ссылка. */
export function containsUrl(text: string): boolean {
  URL_PATTERN.lastIndex = 0;
  SCHEMELESS_URL_PATTERN.lastIndex = 0;
  MAILTO_PATTERN.lastIndex = 0;
  return (
    URL_PATTERN.test(text) ||
    SCHEMELESS_URL_PATTERN.test(text) ||
    MAILTO_PATTERN.test(text)
  );
}
