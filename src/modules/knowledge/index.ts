/**
 * Публичный API модуля базы знаний.
 *
 * Наружу отдаётся только `search`; внутренние файлы модуля напрямую
 * не импортируются (docs/api-contract.md §1).
 */
export { search } from "./search";
export type { EmbeddingProvider, SearchResult } from "./search";
