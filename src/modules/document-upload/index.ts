/**
 * Публичный API модуля загрузки документов базы знаний.
 *
 * Наружу отдаются операции потока, типы и доменная ошибка. Внутренние файлы
 * (`parse.ts`, `chunking.ts`, `repository.ts`) наружу не выходят: доступ к
 * `pg` остаётся внутри модуля, как требует `docs/api-contract.md` §1.
 */

export {
  uploadDocument,
  retryDocumentParse,
  approveDocument,
  rejectDocument,
  getDocument,
  listDocuments,
  MAX_DOCUMENT_BYTES,
} from "./service";
export { KnowledgeDocumentError, documentHttpStatus } from "./errors";
export { SUPPORTED_FORMATS_LABEL } from "./parse";
export type {
  DocumentEmbeddingProvider,
  DocumentErrorCode,
  DocumentFilter,
  DocumentParser,
  DocumentRecord,
  DocumentStatus,
  DocumentUploadInput,
  DocumentUploadOptions,
  ParseStatus,
  ParsedDocument,
  SupportedDocumentFormat,
} from "./types";
