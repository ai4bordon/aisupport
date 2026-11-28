import { randomUUID } from "node:crypto";

import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { accessHttpStatus, checkManagerAccess } from "@/modules/access";
import {
  ArticleDraftError,
  rejectArticleDraft,
} from "@/modules/article-drafts";
import { listDocuments } from "@/modules/document-upload";

/**
 * GET /api/manager/knowledge — данные раздела кабинера «База знаний».
 *
 * Маршрут отдаёт два разных списка:
 * - `documents` — загруженные менеджером материалы (`kb_documents`);
 * - `drafts` — статьи базы знаний (`kb_articles`), в том числе черновики,
 *   ждущие решения менеджера.
 *
 * Документы и черновики статей — разные сущности с разными маршрутами
 * одобрения (ADR-0005): список общий только для показа, а решение по
 * каждому материалу принимается своим маршрутом.
 *
 * Барьер кабинета (`support_access`). Арендатор определяется
 * сервером и не принимается из тела запроса.
 *
 * POST /api/manager/knowledge — отклонение черновика статьи.
 *
 * Отдельно стоящий маршрут контракта для отклонения нет (`docs/api-contract.md`
 * §3 перечисляет только одобрение), поэтому решение менеджера принимает
 * маршрут раздела: тело задаёт материал и действие. Одобрение остаётся на
 * своих маршрутах `/kb/documents/{id}/approve` и `/kb/drafts/{id}/approve` —
 * там оно уже заморожено контрактом.
 */

/** Документ в теле ответа — snake_case по контракту внешнего HTTP API. */
type KnowledgeDocument = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  parse_status: string;
  parse_error: string | null;
  chunks_count: number;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
};

/** Статья (черновик) в теле ответа — snake_case по контракту. */
type KnowledgeDraft = {
  id: string;
  title: string;
  /**
   * Полный текст материала.
   *
   * В списке нужен для поиска по тексту: иначе менеджер ищет только по
   * заголовку и не находит материал по фразе из статьи.
   */
  body_md: string;
  status: string;
  conversation_id: string | null;
  source_message_ids: string[];
  source_excerpt: string | null;
  owner: string | null;
  created_at: string;
  approved_by: string | null;
  reviewed_at: string | null;
  published_at: string | null;
};

/** Строка `kb_articles` в терминах маршрута. */
type ArticleRow = {
  id: string;
  title: string;
  body_md: string;
  status: string;
  conversation_id: string | null;
  source_message_ids: unknown;
  source_excerpt: string | null;
  owner: string | null;
  created_at: Date;
  approved_by: string | null;
  reviewed_at: Date | null;
  published_at: Date | null;
};

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        details: {},
        request_id: requestId,
      },
    },
    { status },
  );
}

/** Идентификаторы сообщений источника: в базе это jsonb-массив. */
function messageIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}

/**
 * Разбор параметров выборки списка черновиков.
 *
 * Параметры необязательны: вызов без них отдаёт весь список, как и раньше.
 * `status` сужает список по состоянию материала, `limit` задаёт размер
 * страницы, `offset` — сколько записей пропустить. Размер страницы
 * ограничен сверху: маршрут не должен отдавать кабинету всю базу одним
 * ответом.
 */
const MAX_DRAFTS_PAGE_SIZE = 100;

type DraftsQuery = {
  status: string | null;
  limit: number | null;
  offset: number;
};

/** Ошибка разбора параметров выборки: клиентский ввод неверен. */
class QueryError extends Error {}

/**
 * Чтение параметров выборки из адреса запроса.
 *
 * Пустые и отсутствующие параметры — обычный вызов без выборки. Неверное
 * значение — ошибка ввода, а не молчаливая подмена.
 */
function readDraftsQuery(request: Request): DraftsQuery {
  const params = new URL(request.url).searchParams;
  const rawStatus = params.get("status")?.trim() ?? "";
  const rawLimit = params.get("limit")?.trim() ?? "";
  const rawOffset = params.get("offset")?.trim() ?? "";

  const status = rawStatus.length > 0 ? rawStatus : null;

  let limit: number | null = null;
  if (rawLimit.length > 0) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new QueryError("Параметр limit должен быть целым числом больше нуля");
    }
    limit = Math.min(parsed, MAX_DRAFTS_PAGE_SIZE);
  }

  let offset = 0;
  if (rawOffset.length > 0) {
    const parsed = Number(rawOffset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new QueryError("Параметр offset должен быть целым числом не меньше нуля");
    }
    offset = parsed;
  }

  return { status, limit, offset };
}

/** Тело решения менеджера по черновику. */
type DecisionBody = {
  draft_id?: string;
  action?: string;
  actor?: string;
};

export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  const access = await checkManagerAccess({
    cookieHeader: request.headers.get("cookie"),
  });
  if (!access.allowed) {
    return errorResponse(
      accessHttpStatus(access),
      "unauthorized",
      "Требуется доступ менеджера",
      requestId,
    );
  }

  let query: DraftsQuery;
  try {
    query = readDraftsQuery(request);
  } catch (error) {
    if (error instanceof QueryError) {
      return errorResponse(
        400,
        "validation_error",
        error.message,
        requestId,
      );
    }
    throw error;
  }

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }

  try {
    const records = await listDocuments(tenantId);
    const documents: KnowledgeDocument[] = records.map((record) => ({
      id: record.id,
      filename: record.filename,
      mime_type: record.mimeType,
      size_bytes: record.sizeBytes,
      status: record.status,
      parse_status: record.parseStatus,
      parse_error: record.parseError,
      chunks_count: record.chunksCount,
      created_at: record.createdAt,
      approved_by: record.approvedBy,
      approved_at: record.approvedAt,
    }));

    // Статьи читаются напрямую: публичного списка у модуля черновиков нет,
    // а кабинету нужен весь список арендатора — и ждущие решения, и уже
    // опубликованные.
    //
    // Выборка (`status`, `limit`, `offset`) — по черновикам: список
    // документов кабинету нужен целиком, а черновиков может быть много.
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }

    const where = conditions.join(" AND ");
    const countResult = await getPool().query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM kb_articles WHERE ${where}`,
      values,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const pageValues = [...values];
    let pageClause = "";
    if (query.limit !== null) {
      pageValues.push(query.limit);
      pageClause += ` LIMIT $${pageValues.length}`;
    }
    if (query.offset > 0) {
      pageValues.push(query.offset);
      pageClause += ` OFFSET $${pageValues.length}`;
    }

    const articles = await getPool().query<ArticleRow>(
      `SELECT id, title, body_md, status, conversation_id, source_message_ids,
              source_excerpt, owner, created_at, approved_by, reviewed_at, published_at
         FROM kb_articles
        WHERE ${where}
        ORDER BY created_at DESC, id DESC${pageClause}`,
      pageValues,
    );

    const drafts: KnowledgeDraft[] = articles.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body_md: row.body_md,
      status: row.status,
      conversation_id: row.conversation_id,
      source_message_ids: messageIds(row.source_message_ids),
      source_excerpt: row.source_excerpt,
      owner: row.owner,
      created_at: row.created_at.toISOString(),
      approved_by: row.approved_by,
      reviewed_at: row.reviewed_at?.toISOString() ?? null,
      published_at: row.published_at?.toISOString() ?? null,
    }));

    return Response.json({
      documents,
      drafts,
      // Всего черновиков под фильтром: клиент рисует по этому числу
      // последнюю страницу и не показывает лишние кнопки перехода.
      drafts_total: total,
    });
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }
}

/**
 * POST /api/manager/knowledge — решение менеджера по черновику статьи.
 *
 * Поддерживается одно действие — `reject`: материал переводится в состояние
 * `rejected` и больше не попадает в поиск. Отклонённый черновик не
 * индексируется, поэтому в базе остаётся только запись о решении.
 *
 * Одобрение намеренно не здесь: оно живёт на своих маршрутах
 * (`/kb/documents/{id}/approve`, `/kb/drafts/{id}/approve`), и его контракт
 * заморожен (`docs/api-contract.md` §3).
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  const access = await checkManagerAccess({
    cookieHeader: request.headers.get("cookie"),
  });
  if (!access.allowed) {
    return errorResponse(
      accessHttpStatus(access),
      "unauthorized",
      "Требуется доступ менеджера",
      requestId,
    );
  }

  let body: DecisionBody;
  try {
    body = (await request.json()) as DecisionBody;
  } catch {
    return errorResponse(
      400,
      "validation_error",
      "Тело запроса не разобрано",
      requestId,
    );
  }

  const action = body.action?.trim() ?? "";
  const draftId = body.draft_id?.trim() ?? "";
  if (action !== "reject") {
    return errorResponse(
      400,
      "validation_error",
      "Поддерживается только действие reject: одобрение идёт своими маршрутами",
      requestId,
    );
  }
  if (draftId.length === 0) {
    return errorResponse(
      400,
      "validation_error",
      "Нужно поле draft_id",
      requestId,
    );
  }

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }

  try {
    const draft = await rejectArticleDraft({
      tenantId,
      id: draftId,
      actor: body.actor?.trim() || "manager",
    });

    return Response.json({
      id: draft.id,
      status: draft.status,
      title: draft.title,
      approved_by: draft.approvedBy,
      reviewed_at: draft.reviewedAt?.toISOString() ?? null,
    });
  } catch (error) {
    if (error instanceof ArticleDraftError) {
      const status =
        error.code === "validation_error"
          ? 400
          : error.code === "not_found"
            ? 404
            : 409;
      return errorResponse(status, error.code, error.message, requestId);
    }
    return errorResponse(
      500,
      "internal_error",
      "Не удалось отклонить черновик",
      requestId,
    );
  }
}
