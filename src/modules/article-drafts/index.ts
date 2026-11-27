/**
 * Публичный API модуля черновиков статей.
 *
 * Наружу отдаются операции потока статьи и типы: `repository.ts` наружу не
 * выходит, наружу не выходят и внутренние функции индексации (docs/api-contract.md §1).
 *
 * Модуль обслуживает только статьи из материалов диалога. Поток загруженных
 * документов живёт отдельно, и операции этого модуля не меняют статус
 * `kb_documents` (ADR-0005).
 */

export {
  approveAndPublishArticleDraft,
  approveArticleDraft,
  createArticleDraft,
  getArticleDraft,
  publishArticleDraft,
  rejectArticleDraft,
} from "./service";

export { ArticleDraftError } from "./types";

export type {
  ApproveArticleDraftInput,
  ArticleDraftErrorCode,
  ArticleDraftInput,
  ArticleDraftRecord,
  ArticleDraftStatus,
  PublishArticleDraftInput,
  RejectArticleDraftInput,
} from "./types";
