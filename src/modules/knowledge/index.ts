/**
 * Публичный API модуля базы знаний.
 *
 * Наружу отдаются `search`, `initEmbeddingProvider` и `setEmbeddingProvider`:
 * последние — граница, через которую выбирается и подменяется эмбеддинг.
 * Внутренние файлы модуля напрямую не импортируются (docs/api-contract.md §1).
 */
export {
  search,
  initEmbeddingProvider,
  currentEmbeddingProvider,
  setEmbeddingProvider,
} from "./search";
export type { EmbeddingProvider, SearchResult } from "./search";
