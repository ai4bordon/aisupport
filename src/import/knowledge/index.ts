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
export { chunkSource, selectIndexableChunks, sourceId } from "./chunk";
export type { Chunk, SourceContent } from "./chunk";
export { importDocsSite, importCrawledPages } from "./importer";
export type { ImportDocsSiteOptions, ImportOptions, ImportReport } from "./importer";
export {
  createEmbeddingProvider,
  createDeterministicEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
} from "./embedding";
export type { EmbeddingProvider } from "./embedding";
