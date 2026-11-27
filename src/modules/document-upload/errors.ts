import type { DocumentErrorCode } from "./types";

/**
 * Доменная ошибка модуля загрузки документов.
 *
 * Код ошибки соответствует таблице `docs/api-contract.md` §2: по нему HTTP-граница
 * выбирает статус ответа, а не разбирает текст сообщения.
 */
export class KnowledgeDocumentError extends Error {
  readonly code: DocumentErrorCode;

  /** Поле, к которому относится ошибка: имя файла, идентификатор документа. */
  readonly field: string | null;

  constructor(code: DocumentErrorCode, field: string | null, message: string) {
    super(message);
    this.name = "KnowledgeDocumentError";
    this.code = code;
    this.field = field;
  }
}

/** HTTP-статус для доменной ошибки — по таблице ошибок контракта §2. */
export function documentHttpStatus(code: DocumentErrorCode): number {
  switch (code) {
    case "unsupported_media_type":
      return 415;
    case "payload_too_large":
      return 413;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    default:
      // `parse_failed` и `index_failed` — состояния материала, а не отказа
      // запроса: они попадают в тело документа и в ответ 202 загрузки.
      return 422;
  }
}
