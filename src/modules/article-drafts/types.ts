/**
 * Типы модуля черновиков статей.
 *
 * Черновик статьи — отдельная сущность со своим жизненным циклом: материал
 * из диалога ждёт решения менеджера, и только после явного одобрения и
 * публикации он попадает в поиск базы знаний. Переходы состояний статьи не
 * переиспользуют переходы загруженных документов (ADR-0005).
 */

/**
 * Состояния проверки статьи.
 *
 * - `pending_review` — материал собран из диалога и ждёт решения менеджера;
 * - `approved` — одобрен, но ещё не опубликован;
 * - `published` — доступен поиску базы знаний;
 * - `rejected` — решение принято, материал не используется.
 *
 * Состояние `draft` таблицы `kb_articles` в этот поток не входит: ожидание
 * тикета — это отдельное `pending_review`, а не служебный `draft`.
 */
export type ArticleDraftStatus =
  | "pending_review"
  | "approved"
  | "published"
  | "rejected";

/** Создание черновика: материал диалога и текст статьи. */
export type ArticleDraftInput = {
  /** Арендатор определён сервером и не приходит из тела запроса. */
  tenantId: string;
  /** Менеджер, создавший материал: попадает в `owner`. */
  actor: string;
  /** Исходный диалог, из которого собран материал. */
  conversationId: string;
  /** Сообщения диалога, вошедшие в материал. */
  sourceMessageIds: string[];
  /** Выдержка из исходного материала: что менеджер взял в статью. */
  sourceExcerpt: string | null;
  title: string;
  bodyMd: string;
};

/** Одобрение материала менеджером. */
export type ApproveArticleDraftInput = {
  tenantId: string;
  id: string;
  actor: string;
};

/** Публикация одобренного материала. */
export type PublishArticleDraftInput = {
  tenantId: string;
  id: string;
};

/** Отклонение материала менеджером. */
export type RejectArticleDraftInput = {
  tenantId: string;
  id: string;
  actor: string;
};

/** Запись черновика в её текущем состоянии. */
export type ArticleDraftRecord = {
  id: string;
  tenantId: string;
  status: ArticleDraftStatus;
  /** Исходный диалог: null у статей, заведённых вне потока тикета. */
  conversationId: string | null;
  sourceMessageIds: string[];
  sourceExcerpt: string | null;
  title: string;
  bodyMd: string;
  owner: string | null;
  /** Менеджер, принявший решение по материалу. */
  approvedBy: string | null;
  createdAt: Date;
  /** Время решения менеджера. */
  reviewedAt: Date | null;
  /** Время публикации: с этого момента статья доступна поиску. */
  publishedAt: Date | null;
  /** Время одобрения. */
  approvedAt: Date | null;
};

/**
 * Коды доменных ошибок модуля.
 *
 * Коды совпадают с кодами контракта HTTP: `validation_error` — 400,
 * `not_found` — 404, `conflict` — 409.
 */
export type ArticleDraftErrorCode =
  | "validation_error"
  | "not_found"
  | "conflict";

/**
 * Доменная ошибка модуля черновиков.
 *
 * Модуль не знает HTTP: он сообщает код и понятный текст, а маршрут
 * переводит их в статус ответа по таблице ошибок контракта §2.
 */
export class ArticleDraftError extends Error {
  readonly code: ArticleDraftErrorCode;

  constructor(code: ArticleDraftErrorCode, message: string) {
    super(message);
    this.name = "ArticleDraftError";
    this.code = code;
  }
}
