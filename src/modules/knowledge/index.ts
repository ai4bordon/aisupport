/**
 * Публичный API модуля базы знаний.
 *
 * Наружу отдаются `search` и `setEmbeddingProvider`: второй — граница, через
 * которую подменяется эмбеддинг (в тестах и песочнице). Внутренние файлы
 * модуля напрямую не импортируются (docs/api-contract.md §1).
 */
export { search, setEmbeddingProvider } from "./search";
export type { EmbeddingProvider, SearchResult } from "./search";
