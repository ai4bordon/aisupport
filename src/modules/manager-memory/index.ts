/**
 * Память ответов менеджера (R7, R12, ADR-0019).
 *
 * Ответ, который менеджер разрешил действием «запомнить ответ», сам
 * является одобрением: отдельного одобрения старшего и срока устаревания
 * не требуется. Материал сразу попадает в общий поиск с исходным
 * обращением как источником — следующий клиент получает этот ответ.
 *
 * Черновики, созданные агентом, живут отдельным циклом: до одобрения
 * менеджером они недоступны поиску.
 */

import { getPool } from "@/db/pool";
import {
  approveAndPublishArticleDraft,
  createArticleDraft,
  ArticleDraftError,
  type ArticleDraftRecord,
} from "@/modules/article-drafts";

/** Вход действия «запомнить ответ». */
export type RememberAnswerInput = {
  /** Арендатор определяется сервером и не приходит из тела запроса. */
  tenantId: string;
  /** Менеджер, сохранивший ответ. */
  actor: string;
  /** Диалог, на который ответит сохранённый материал. */
  conversationId: string;
  /** Заголовок сохранённого ответа. */
  title: string;
  /** Текст ответа менеджера. */
  bodyMd: string;
};

/** Результат сохранения ответа. */
export type RememberedAnswer = {
  /** Идентификатор опубликованной статьи. */
  articleId: string;
  /** Заголовок сохранённого ответа. */
  title: string;
  /** Статус материала: `published`. */
  status: string;
};

/**
 * Сохраняет ответ менеджера как источник базы знаний.
 *
 * Ответ сохраняется сразу опубликованным: действие менеджера и есть
 * одобрение. Промежуточный статус черновика не остаётся надолго, но
 * сохраняется в истории — по нему видно, что материал прошёл через
 * проверку, а не появился из ниоткуда.
 *
 * Источником статьи остаётся исходное обращение: у ответа менеджера нет
 * своего адреса, и подменять его выдуманной ссылкой нельзя.
 */
export async function rememberAnswer(
  input: RememberAnswerInput,
): Promise<RememberedAnswer> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Сообщения исходного диалога: статья ссылается на конкретные
    // реплики клиента, из которых ответ вырос.
    const messages = await client.query<{ id: string }>(
      `SELECT id FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND role = 'client'
        ORDER BY created_at ASC, id ASC`,
      [input.tenantId, input.conversationId],
    );
    if (messages.rows.length === 0) {
      throw new ArticleDraftError(
        "validation_error",
        "В исходном диалоге нет сообщений клиента — сохранять ответ не из чего",
      );
    }

    const draft = await createArticleDraft({
      tenantId: input.tenantId,
      actor: input.actor,
      conversationId: input.conversationId,
      sourceMessageIds: messages.rows.map((row) => row.id),
      sourceExcerpt: input.bodyMd.slice(0, 500),
      title: input.title,
      bodyMd: input.bodyMd,
    });

    const published = await approveAndPublishArticleDraft({
      tenantId: input.tenantId,
      id: draft.id,
      actor: input.actor,
    });

    await client.query("COMMIT");
    return {
      articleId: published.id,
      title: published.title,
      status: published.status,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Заголовок ответа по умолчанию: первые слова текста менеджера. */
export function defaultAnswerTitle(bodyMd: string): string {
  const firstLine = bodyMd.split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return "Ответ менеджера";
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

/** Тип записи статьи для чтения из кабинета. */
export type { ArticleDraftRecord };
