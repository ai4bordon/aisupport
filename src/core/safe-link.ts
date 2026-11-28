/**
 * Безопасные ссылки на источники.
 *
 * Адрес источника приходит из данных: из базы знаний, из снимка фида или
 * из текста статьи. Такой адрес нельзя вставлять в `href` как есть —
 * схема `javascript:` или `data:` выполнит код в браузере клиента.
 *
 * Правило простое: ссылкой становится только `http` и `https` с
 * настоящим адресом хоста. Всё остальное — обычный текст: менеджер видит
 * источник, но кликнуть по нему нельзя.
 */

/** Схемы, по которым переход безопасен. */
const SAFE_SCHEMES = new Set(["http:", "https:"]);

/**
 * Проверка адреса источника.
 *
 * Возвращает адрес, если по нему можно безопасно перейти, и `null`
 * иначе. Относительные адреса и схемы вроде `javascript:` не проходят.
 */
export function safeSourceHref(location: string | null | undefined): string | null {
  if (location === null || location === undefined) {
    return null;
  }
  const trimmed = location.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (!SAFE_SCHEMES.has(url.protocol)) {
      return null;
    }
    // Настоящий хост обязателен: `https://` без адреса — не ссылка.
    if (url.hostname.length === 0) {
      return null;
    }
    return url.toString();
  } catch {
    // Адрес не разбирается как URL: относительный или мусор.
    return null;
  }
}
