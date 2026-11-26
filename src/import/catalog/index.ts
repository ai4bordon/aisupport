// Публичный API импорта фида каталога.
//
// Наружу — только `importFeed` и типы отчёта. Внутренние файлы модуля
// (source, parse, importer) наружу не импортируются.
export { importFeed, type ImportOptions, type ImportReport } from "./importer";
export { LIVE_FEED_URL, openFeedSource, type FeedSource, type SourceKind } from "./source";
export {
  parseFeed,
  type ParsedCategory,
  type ParsedOffer,
  type ParsedRecord,
} from "./parse";
