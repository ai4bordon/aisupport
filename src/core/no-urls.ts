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

/** Ссылка сmarkdown-разметки: `[текст](адрес)` → `текст`. */
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/giu;

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
  return withoutUrls
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Есть ли в тексте ссылка. */
export function containsUrl(text: string): boolean {
  URL_PATTERN.lastIndex = 0;
  return URL_PATTERN.test(text);
}
