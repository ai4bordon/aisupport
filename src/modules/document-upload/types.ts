/**
 * Типы модуля загрузки документов базы знаний.
 *
 * Формат файла определяется по расширению и по сигнатуре содержимого: одно
 * без другого недостаточно, потому что переименованный файл не должен
 * разбираться как другой формат.
 */

/** Форматы, которые принимает загрузка. */
export type SupportedDocumentFormat = "pdf" | "docx" | "md" | "txt";

/** Статус публикации документа. */
export type DocumentStatus = "pending" | "published" | "rejected" | "error";

/** Результат разбора: отделён от статуса публикации. */
export type ParseStatus = "not_parsed" | "parsed" | "failed";

/**
 * Коды доменных ошибок модуля.
 *
 * `validation_error` добавлен к кодам контракта: пустой файл не является
 * «неподдерживаемым форматом» и не является «слишком большим», но и
 * разбирать его нечего.
 */
export type DocumentErrorCode =
  | "unsupported_media_type"
  | "payload_too_large"
  | "parse_failed"
  | "index_failed"
  | "not_found"
  | "conflict"
  | "validation_error";

/** Вход загрузки документа. */
export type DocumentUploadInput = {
  /** Арендатор определён сервером и не приходит из тела запроса. */
  tenantId: string;
  /** Имя файла как его прислал менеджер. */
  filename: string;
  /** MIME-тип, заявленный клиентом: проверяется, но не является основанием. */
  mimeType: string;
  /** Содержимое файла. */
  bytes: Buffer;
  /** Кто загрузил: менеджер кабинета. */
  uploadedBy: string;
};

/** Документ базы знаний в терминах модуля. */
export type DocumentRecord = {
  id: string;
  tenantId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  parseStatus: ParseStatus;
  parseError: string | null;
  chunksCount: number;
  extractedChars: number;
  sourceKind: "manager_upload";
  sourceUrl: string | null;
  snapshotHash: string | null;
  approvedBy: string | null;
  rejectedReason: string | null;
  retryCount: number;
  createdAt: string;
};

/** Фильтр списка документов менеджера. */
export type DocumentFilter = {
  status?: DocumentStatus;
  parseStatus?: ParseStatus;
};

/** Результат разбора файла. */
export type ParsedDocument = {
  /** Формат, подтверждённый сигнатурой содержимого. */
  format: SupportedDocumentFormat;
  /** Извлечённый текст без служебной разметки. */
  text: string;
  /** Число страниц: у PDF и DOCX оно известно, у текста — одна. */
  pages: number;
};

/**
 * Разборщик загруженного файла.
 *
 * Вынесен в тип, чтобы счётчик вызовов разбора можно было подменить в
 * тесте: отказ по формату обязан произойти до разбора.
 */
export type DocumentParser = (
  bytes: Buffer,
  format: SupportedDocumentFormat,
) => ParsedDocument | Promise<ParsedDocument>;

/**
 * Провайдер эмбеддингов, которым индексируются чанки документа.
 *
 * Совпадает с провайдером, которым индексирована база знаний: вектор запроса
 * и вектор чанка строятся одной моделью, иначе поиск отвергает чанк.
 */
export type DocumentEmbeddingProvider = {
  embed: (text: string) => Promise<number[]>;
  model: string;
};

/** Дополнительные параметры операций модуля. */
export type DocumentUploadOptions = {
  /** Разборщик; по умолчанию — встроенный. */
  parser?: DocumentParser;
  /** Провайдер эмбеддингов; по умолчанию — провайдер базы знаний. */
  embeddingProvider?: DocumentEmbeddingProvider;
};
