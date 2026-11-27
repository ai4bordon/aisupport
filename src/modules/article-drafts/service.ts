/**
 * Операции над черновиками статей.
 *
 * Жизненный цикл статьи — собственный и не переиспользует переходы
 * загруженных документов (ADR-0005):
 *
 *   создание → `pending_review` → одобрение → `approved` → публикация → `published`
 *                              ↘ отклонение → `rejected`
 *
 * Инварианты:
 * - создать можно только `pending_review`: иного состояния у нового материала нет;
 * - одобрить можно только `pending_review`, опубликовать — только `approved`;
 * - повтор операции над состоянием, которого нет в переходах, — `conflict`;
 * - чужой арендатор не узнаёт о существовании записи: `not_found`;
 * - до публикации чанки статьи не создаются, поэтому черновик не находится
 *   поиском даже при прямом запросе к `kb_chunks`;
 * - публикация транзакционна: ошибка индексации не оставляет опубликованную
 *   статью без поисковых чанков;
 * - модуль не пишет в `kb_documents`: документный поток не затрагивается.
 */

import type { PoolClient } from "pg";
import { getPool } from "@/db/pool";
import { toVectorLiteral } from "@/db/vector";
import { currentEmbeddingProvider } from "@/modules/knowledge";
import { chunkSource } from "@/import/knowledge";
import {
  ArticleDraftError,
  type ApproveArticleDraftInput,
  type ArticleDraftInput,
  type ArticleDraftRecord,
  type ArticleDraftStatus,
  type PublishArticleDraftInput,
  type RejectArticleDraftInput,
  type UpdateArticleDraftInput,
} from "./types";
import {
  deleteArticle,
  deleteArticleChunks,
  insertArticleChunk,
  insertArticleDraft,
  selectArticle,
  selectConversation,
  selectConversationMessages,
  transitionArticle,
  updateArticle,
  type ArticleRow,
} from "./repository";

/** UUID сообщения: формат проверяется до похода в базу. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Ссылка на источник статьи.
 *
 * У материала менеджера нет URL: исходный материал — это диалог. Ссылка на
 * источник указывает именно на него; выдуманный адрес в цитате был бы
 * враньём, и по контракту §6 источник должен быть настоящим.
 */
function sourceReference(conversationId: string | null): string {
  return conversationId === null ? "диалог без источника" : `диалог ${conversationId}`;
}

/** Приведение строки записи к типу модуля. */
function toRecord(row: ArticleRow): ArticleDraftRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status as ArticleDraftStatus,
    conversationId: row.conversation_id,
    sourceMessageIds: Array.isArray(row.source_message_ids)
      ? row.source_message_ids.map(String)
      : [],
    sourceExcerpt: row.source_excerpt,
    title: row.title,
    bodyMd: row.body_md,
    version: row.version,
    owner: row.owner,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
    approvedAt: row.approved_at,
  };
}

/** Проверка входных данных создания материала. */
function validateDraftInput(input: ArticleDraftInput): void {
  if (input.tenantId.trim().length === 0) {
    throw new ArticleDraftError("validation_error", "Не указан арендатор");
  }
  if (input.actor.trim().length === 0) {
    throw new ArticleDraftError("validation_error", "Не указан менеджер");
  }
  if (input.title.trim().length === 0) {
    throw new ArticleDraftError("validation_error", "Заголовок статьи обязателен");
  }
  if (input.bodyMd.trim().length === 0) {
    throw new ArticleDraftError("validation_error", "Текст статьи обязателен");
  }
  if (!UUID_PATTERN.test(input.conversationId)) {
    throw new ArticleDraftError(
      "validation_error",
      "Идентификатор исходного диалога не является UUID",
    );
  }
  if (input.sourceMessageIds.length === 0) {
    throw new ArticleDraftError(
      "validation_error",
      "Нужен хотя бы один идентификатор сообщения исходного диалога",
    );
  }
  for (const messageId of input.sourceMessageIds) {
    if (!UUID_PATTERN.test(messageId)) {
      throw new ArticleDraftError(
        "validation_error",
        "Идентификатор сообщения исходного диалога не является UUID",
      );
    }
  }
}

/**
 * Создание черновика статьи из материала диалога.
 *
 * Создаётся только состояние `pending_review`: материал ждёт решения
 * менеджера и до него не индексируется.
 */
export async function createArticleDraft(
  input: ArticleDraftInput,
): Promise<ArticleDraftRecord> {
  validateDraftInput(input);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const conversation = await selectConversation(
      client,
      input.tenantId,
      input.conversationId,
    );
    if (!conversation) {
      throw new ArticleDraftError(
        "validation_error",
        "Исходный диалог не найден или принадлежит другому арендатору",
      );
    }

    // Сообщения берутся только из выбранного диалога: провенанс не может
    // сослаться на чужое или несуществующее сообщение.
    const found = await selectConversationMessages(
      client,
      input.tenantId,
      input.conversationId,
      input.sourceMessageIds,
    );
    if (found.length !== input.sourceMessageIds.length) {
      throw new ArticleDraftError(
        "validation_error",
        "Указано сообщение, которого нет в исходном диалоге",
      );
    }

    const row = await insertArticleDraft(client, {
      tenantId: input.tenantId,
      title: input.title.trim(),
      bodyMd: input.bodyMd.trim(),
      owner: input.actor.trim(),
      conversationId: input.conversationId,
      sourceMessageIds: input.sourceMessageIds,
      sourceExcerpt: input.sourceExcerpt,
    });

    await client.query("COMMIT");
    return toRecord(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Одобрение материала менеджером: `pending_review → approved`.
 *
 * Одобрение не публикует материал: до явной публикации статья остаётся
 * недоступной поиску.
 */
export async function approveArticleDraft(
  input: ApproveArticleDraftInput,
): Promise<ArticleDraftRecord> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await approveWithin(client, input.tenantId, input.id, input.actor);
    await client.query("COMMIT");
    return toRecord(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Отклонение материала менеджером: `pending_review → rejected`.
 *
 * Отклонённый материал не индексируется и никогда не попадает в поиск.
 */
export async function rejectArticleDraft(
  input: RejectArticleDraftInput,
): Promise<ArticleDraftRecord> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await selectArticle(client, input.tenantId, input.id);
    if (!current) {
      throw new ArticleDraftError("not_found", "Черновик не найден");
    }
    if (current.status !== "pending_review") {
      throw new ArticleDraftError(
        "conflict",
        `Отклонить можно только материал в статусе ожидания, текущий статус — ${current.status}`,
      );
    }

    const now = new Date();
    const row = await transitionArticle(client, {
      tenantId: input.tenantId,
      id: input.id,
      fromStatus: "pending_review",
      toStatus: "rejected",
      approvedBy: input.actor,
      reviewedAt: now,
    });
    if (!row) {
      throw new ArticleDraftError(
        "conflict",
        "Материал изменился до решения менеджера — повторите операцию",
      );
    }

    await client.query("COMMIT");
    return toRecord(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Публикация одобренного материала: `approved → published`.
 *
 * Публикация транзакционна: чанки статьи записываются и статус меняется в
 * одной транзакции, поэтому опубликованной статьи без поисковых чанков не
 * бывает, а чанка без статуса `published` — тоже.
 */
export async function publishArticleDraft(
  input: PublishArticleDraftInput,
): Promise<ArticleDraftRecord> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await publishWithin(client, input.tenantId, input.id);
    await client.query("COMMIT");
    return toRecord(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Одобрение и публикация одной транзакцией.
 *
 * HTTP-контракт `/kb/drafts/{id}/approve` завершает процесс опубликованным
 * статусом, но внутри сохраняются два явных перехода:
 * `pending_review → approved → published`. Обе операции идут в одной
 * транзакции: материал не остаётся наполовину обработанным.
 */
export async function approveAndPublishArticleDraft(
  input: ApproveArticleDraftInput,
): Promise<ArticleDraftRecord> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await approveWithin(client, input.tenantId, input.id, input.actor);
    const row = await publishWithin(client, input.tenantId, input.id);
    await client.query("COMMIT");
    return toRecord(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Чтение черновика в пределах арендатора. */
export async function getArticleDraft(
  tenantId: string,
  id: string,
): Promise<ArticleDraftRecord | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const row = await selectArticle(client, tenantId, id);
    return row ? toRecord(row) : null;
  } finally {
    client.release();
  }
}

/**
 * Статусы, в которых текст материала ещё можно править.
 *
 * Правка материала, по которому решение уже принято, не проходит: решение
 * менеджера относится к тому тексту, который он видел, и правка после
 * решения сделала бы решение бессмысленным.
 */
const EDITABLE_STATUSES: ArticleDraftStatus[] = ["pending_review", "approved"];

/**
 * Правка текста черновика.
 *
 * Правка меняет текст и увеличивает версию материала. Чанки при этом не
 * трогаются: до публикации материал не индексируется, а опубликованную
 * статью правят через новый цикл публикации.
 */
export async function updateArticleDraft(
  input: UpdateArticleDraftInput,
): Promise<ArticleDraftRecord> {
  const bodyMd = input.bodyMd.trim();
  if (bodyMd.length === 0) {
    throw new ArticleDraftError("validation_error", "Текст статьи не может быть пустым");
  }
  const title = input.title?.trim();

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await selectArticle(client, input.tenantId, input.id);
    if (!current) {
      throw new ArticleDraftError("not_found", "Черновик не найден");
    }

    const row = await updateArticle(client, {
      tenantId: input.tenantId,
      id: input.id,
      bodyMd,
      title: title !== undefined && title.length > 0 ? title : undefined,
      allowedStatuses: EDITABLE_STATUSES,
    });
    if (!row) {
      throw new ArticleDraftError(
        "conflict",
        `Править можно только материал, по которому решение не принято, текущий статус — ${current.status}`,
      );
    }

    await client.query("COMMIT");
    return toRecord(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Удаление черновика.
 *
 * Удаляются и чанки материала: они ссылаются на статью, и статьи без
 * текста в базе не остаётся. Опубликованный материал удалить нельзя —
 * он уже в поиске, и решение об этом принимается не здесь.
 */
export async function deleteArticleDraft(
  tenantId: string,
  id: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await selectArticle(client, tenantId, id);
    if (!current) {
      throw new ArticleDraftError("not_found", "Черновик не найден");
    }
    if (current.status === "published") {
      throw new ArticleDraftError(
        "conflict",
        "Опубликованную статью удалить нельзя: она доступна поиску",
      );
    }

    await deleteArticle(client, tenantId, id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Переход `pending_review → approved` внутри открытой транзакции. */
async function approveWithin(
  client: PoolClient,
  tenantId: string,
  id: string,
  actor: string,
): Promise<ArticleRow> {
  const current = await selectArticle(client, tenantId, id);
  if (!current) {
    throw new ArticleDraftError("not_found", "Черновик не найден");
  }
  if (current.status !== "pending_review") {
    throw new ArticleDraftError(
      "conflict",
      `Одобрить можно только материал в статусе ожидания, текущий статус — ${current.status}`,
    );
  }

  const now = new Date();
  const row = await transitionArticle(client, {
    tenantId,
    id,
    fromStatus: "pending_review",
    toStatus: "approved",
    approvedBy: actor,
    reviewedAt: now,
    approvedAt: now,
  });
  if (!row) {
    throw new ArticleDraftError(
      "conflict",
      "Материал изменился до решения менеджера — повторите операцию",
    );
  }
  return row;
}

/** Переход `approved → published` и индексация внутри открытой транзакции. */
async function publishWithin(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<ArticleRow> {
  const current = await selectArticle(client, tenantId, id);
  if (!current) {
    throw new ArticleDraftError("not_found", "Черновик не найден");
  }
  if (current.status !== "approved") {
    throw new ArticleDraftError(
      "conflict",
      `Опубликовать можно только одобренный материал, текущий статус — ${current.status}`,
    );
  }

  // Чанки пишутся до смены статуса: если индексация не удалась, переход не
  // выполняется, и статья не остаётся опубликованной без поисковых чанков.
  await indexArticle(client, tenantId, current);

  const now = new Date();
  const row = await transitionArticle(client, {
    tenantId,
    id,
    fromStatus: "approved",
    toStatus: "published",
    publishedAt: now,
    validFrom: now,
  });
  if (!row) {
    throw new ArticleDraftError(
      "conflict",
      "Материал изменился до публикации — повторите операцию",
    );
  }
  return row;
}

/**
 * Индексация статьи: цитируемые чанки с вектором текущей модели.
 *
 * Модель эмбеддингов берётся у модуля базы знаний: вектор запроса и вектор
 * чанка строятся одной моделью, иначе они несопоставимы (R18, R24).
 */
async function indexArticle(
  client: PoolClient,
  tenantId: string,
  row: ArticleRow,
): Promise<void> {
  const provider = currentEmbeddingProvider();
  const reference = sourceReference(row.conversation_id);

  // Шапка чанка несёт ссылку на источник: так цитата в поиске указывает на
  // исходный диалог. Это разбор текста, а не выдуманный URL.
  const chunks = chunkSource({
    url: reference,
    title: row.title,
    sectionPath: "",
    text: row.body_md,
    crawledAt: new Date().toISOString(),
  });
  if (chunks.length === 0) {
    throw new ArticleDraftError(
      "validation_error",
      "Текст статьи пуст — индексировать нечего",
    );
  }

  await deleteArticleChunks(client, tenantId, row.id);
  for (const chunk of chunks) {
    const vector = await provider.embed(chunk.text);
    await insertArticleChunk(client, {
      tenantId,
      articleId: row.id,
      chunkNo: chunk.chunkNo,
      text: chunk.text,
      embedding: toVectorLiteral(vector),
      embeddingModel: provider.model,
    });
  }
}
