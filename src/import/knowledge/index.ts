/**
 * Публичный API модуля импорта базы знаний.
 *
 * Наружу выдаются только `crawlSite` и `extractPage`: внутренние файлы
 * модуля вне его не импортируются.
 */

export { crawlSite } from "./crawl";
export type { CrawlOptions, CrawlReport, CrawledPage } from "./crawl";
export { extractPage } from "./extract";
export type { ExtractedPage } from "./extract";
