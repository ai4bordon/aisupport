/**
 * Доступ к данным модуля черновиков статей.
 *
 * Модуль работает только с двумя таблицами: `kb_articles` (сама статья и её
 * провенанс) и `kb_chunks` (цитируемые чанки статьи). Таблицу
 * `kb_documents` модуль не читает и не меняет: документ и статья — разные
 * сущности, и общий поток одобрения у них разный (ADR-0005).
 *
 * `pg` не выходит за пределы модуля: наружу отдаются операции с готовыми
 * значениями, а не пул соединений.
 */

import type { PoolClient } from "pg";

/** Строка `kb_articles` в терминах модуля. */
export type ArticleRow = {
  id: string;
  tenant_id: string;
  title: string;
  body_md: string;
  status: string;
  version: number;
  valid_from: Date;
  valid_to: Date | null;
  owner: string | null;
  created_at: Date;
  approved_at: Date | null;
  conversation_id: string | null;
  source_message_ids: string[];
  source_excerpt: string | null;
  approved_by: string | null;
  reviewed_at: Date | null;
  published_at: Date | null;
};

/** Создание статьи в состоянии ожидания проверки. */
export async function insertArticleDraft(
  client: PoolClient,
  values: {
    tenantId: string;
    title: string;
    bodyMd: string;
    owner: string;
    conversationId: string;
    sourceMessageIds: string[];
    sourceExcerpt: string | null;
  },
): Promise<ArticleRow> {
  const result = await client.query<ArticleRow>(
    `INSERT INTO kb_articles (
       tenant_id, title, body_md, status, version, valid_from, owner,
       conversation_id, source_message_ids, source_excerpt
     ) VALUES ($1, $2, $3, 'pending_review', 1, now(), $4, $5, $6::jsonb, $7)
     RETURNING *`,
    [
      values.tenantId,
      values.title,
      values.bodyMd,
      values.owner,
      values.conversationId,
      JSON.stringify(values.sourceMessageIds),
      values.sourceExcerpt,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Статья не создана: база не вернула строку");
  return row;
}

/** Чтение статьи в пределах арендатора. */
export async function selectArticle(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<ArticleRow | null> {
  const result = await client.query<ArticleRow>(
    "SELECT * FROM kb_articles WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return result.rows[0] ?? null;
}

/**
 * Переход состояния статьи.
 *
 * Условие по текущему состоянию стоит в самом `UPDATE`: переход выполняется
 * только из ожидаемого состояния, иначе возвращается `null` — вызывающий
 * слой превращает это в доменную ошибку `conflict`.
 */
export async function transitionArticle(
  client: PoolClient,
  values: {
    tenantId: string;
    id: string;
    fromStatus: string;
    toStatus: string;
    approvedBy?: string | null;
    reviewedAt?: Date | null;
    publishedAt?: Date | null;
    approvedAt?: Date | null;
    validFrom?: Date | null;
  },
): Promise<ArticleRow | null> {
  const result = await client.query<ArticleRow>(
    `UPDATE kb_articles
        SET status = $4,
            approved_by = COALESCE($5, approved_by),
            reviewed_at = COALESCE($6, reviewed_at),
            published_at = COALESCE($7, published_at),
            approved_at = COALESCE($8, approved_at),
            valid_from = COALESCE($9, valid_from)
      WHERE tenant_id = $1 AND id = $2 AND status = $3
      RETURNING *`,
    [
      values.tenantId,
      values.id,
      values.fromStatus,
      values.toStatus,
      values.approvedBy ?? null,
      values.reviewedAt ?? null,
      values.publishedAt ?? null,
      values.approvedAt ?? null,
      values.validFrom ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Правка текста статьи.
 *
 * Версия растёт на единицу: правка видна по номеру, и по нему же видно,
 * что текст менялся. Условие по статусу стоит в самом `UPDATE`: правка
 * материала, по которому решение уже принято, не проходит.
 */
export async function updateArticle(
  client: PoolClient,
  values: {
    tenantId: string;
    id: string;
    bodyMd: string;
    title?: string;
    allowedStatuses: string[];
  },
): Promise<ArticleRow | null> {
  const result = await client.query<ArticleRow>(
    `UPDATE kb_articles
        SET body_md = $4,
            title = COALESCE($5, title),
            version = version + 1
      WHERE tenant_id = $1
        AND id = $2
        AND status = ANY($3::text[])
      RETURNING *`,
    [
      values.tenantId,
      values.id,
      values.allowedStatuses,
      values.bodyMd,
      values.title ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Удаление статьи с её чанками.
 *
 * Чанки удаляются первыми: на них ссылается внешний ключ, и удаление статьи
 * с чанками одним каскадом невозможно — удаление статьи сначала оставило бы
 * чанки без владельца.
 */
export async function deleteArticle(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  await client.query(
    "DELETE FROM kb_chunks WHERE tenant_id = $1 AND article_id = $2",
    [tenantId, id],
  );
  const result = await client.query(
    "DELETE FROM kb_articles WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Проверка диалога: он должен существовать и принадлежать арендатору. */
export async function selectConversation(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2",
    [tenantId, conversationId],
  );
  return result.rows[0] ?? null;
}

/**
 * Сообщения диалога, доступные для материала статьи.
 *
 * Возвращаются только сообщения выбранного диалога: сообщение из чужого
 * диалога в провенанс статьи попасть не может.
 */
export async function selectConversationMessages(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  messageIds: string[],
): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const result = await client.query<{ id: string }>(
    `SELECT id FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = ANY($3::uuid[])`,
    [tenantId, conversationId, messageIds],
  );
  return result.rows.map((row) => row.id);
}

/** Удаление прежних чанков статьи: содержание материала могло измениться. */
export async function deleteArticleChunks(
  client: PoolClient,
  tenantId: string,
  articleId: string,
): Promise<void> {
  await client.query(
    "DELETE FROM kb_chunks WHERE tenant_id = $1 AND article_id = $2",
    [tenantId, articleId],
  );
}

/** Запись цитируемого чанка статьи. */
export async function insertArticleChunk(
  client: PoolClient,
  values: {
    tenantId: string;
    articleId: string;
    chunkNo: number;
    text: string;
    embedding: string;
    embeddingModel: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO kb_chunks (
       tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model
     ) VALUES ($1, $2, $3, $4, to_tsvector('russian', $4), $5::vector, $6)`,
    [
      values.tenantId,
      values.articleId,
      values.chunkNo,
      values.text,
      values.embedding,
      values.embeddingModel,
    ],
  );
}
