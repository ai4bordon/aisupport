import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { accessHttpStatus, checkManagerAccess } from "@/modules/access";
import { getTenantId } from "@/db/tenant";
import {
  ArticleDraftError,
  deleteArticleDraft,
  getArticleDraft,
  updateArticleDraft,
} from "@/modules/article-drafts";

/**
 * `/api/manager/knowledge/draft/{id}` — работа с черновиком статьи в кабинете.
 *
 * Три операции над одним материалом:
 * - `GET` — полный текст статьи: в списке раздела видны только заголовок и
 *   выдержка из источника, а менеджеру нужно читать материал целиком;
 * - `PUT` — правка текста: версия материала растёт, и правка видна по номеру;
 * - `DELETE` — удаление материала вместе с его чанками.
 *
 * Все три операции проходят через барьер `checkManagerAccess`: клиентская
 * cookie доступа сама по себе не даёт права читать и менять материалы
 * кабинета.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const updateSchema = z.object({
  body_md: z.string().min(1).max(200_000),
  title: z.string().min(1).max(300).optional(),
});

/** Статья в теле ответа — snake_case по контракту внешнего HTTP API. */
type DraftBody = {
  id: string;
  title: string;
  body_md: string;
  status: string;
  version: number;
  conversation_id: string | null;
  source_message_ids: string[];
  source_excerpt: string | null;
  owner: string | null;
  created_at: string;
  approved_by: string | null;
  reviewed_at: string | null;
  published_at: string | null;
};

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        details: {},
        request_id: requestId,
      },
    },
    { status, headers: JSON_HEADERS },
  );
}

/** Тело статьи в том виде, в каком его отдаёт кабинет. */
function toDraftBody(draft: {
  id: string;
  title: string;
  bodyMd: string;
  status: string;
  owner: string | null;
  conversationId: string | null;
  sourceMessageIds: string[];
  sourceExcerpt: string | null;
  approvedBy: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  publishedAt: Date | null;
  version: number;
}): DraftBody {
  return {
    id: draft.id,
    title: draft.title,
    body_md: draft.bodyMd,
    status: draft.status,
    version: draft.version,
    conversation_id: draft.conversationId,
    source_message_ids: draft.sourceMessageIds,
    source_excerpt: draft.sourceExcerpt,
    owner: draft.owner,
    created_at: draft.createdAt.toISOString(),
    approved_by: draft.approvedBy,
    reviewed_at: draft.reviewedAt?.toISOString() ?? null,
    published_at: draft.publishedAt?.toISOString() ?? null,
  };
}

/** Барьер и арендатор: без доступа материал не читается и не меняется. */
async function authorize(
  request: Request,
  requestId: string,
): Promise<{ tenantId: string } | { response: NextResponse }> {
  const decision = await checkManagerAccess({
    cookieHeader: request.headers.get("cookie"),
  });
  if (!decision.allowed) {
    return {
      response: errorResponse(
        accessHttpStatus(decision),
        "unauthorized",
        "Требуется доступ менеджера",
        requestId,
      ),
    };
  }

  try {
    return { tenantId: await getTenantId() };
  } catch {
    return {
      response: errorResponse(
        503,
        "upstream_unavailable",
        "База данных недоступна",
        requestId,
      ),
    };
  }
}

/** Идентификатор статьи: формат проверяется до похода в базу. */
function validId(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  const access = await authorize(request, requestId);
  if ("response" in access) {
    return access.response;
  }

  const { id } = await context.params;
  if (!validId(id)) {
    return errorResponse(
      400,
      "validation_error",
      "Идентификатор статьи не является UUID",
      requestId,
    );
  }

  try {
    const draft = await getArticleDraft(access.tenantId, id);
    if (!draft) {
      return errorResponse(404, "not_found", "Черновик не найден", requestId);
    }
    return NextResponse.json(
      { draft: toDraftBody(draft) },
      { headers: JSON_HEADERS },
    );
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  const access = await authorize(request, requestId);
  if ("response" in access) {
    return access.response;
  }

  const { id } = await context.params;
  if (!validId(id)) {
    return errorResponse(
      400,
      "validation_error",
      "Идентификатор статьи не является UUID",
      requestId,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(
      400,
      "validation_error",
      "Тело запроса не разобрано",
      requestId,
    );
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      400,
      "validation_error",
      "Ожидается непустой текст статьи в поле body_md",
      requestId,
    );
  }

  try {
    const draft = await updateArticleDraft({
      tenantId: access.tenantId,
      id,
      bodyMd: parsed.data.body_md,
      title: parsed.data.title,
    });
    return NextResponse.json(
      { draft: toDraftBody(draft) },
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof ArticleDraftError) {
      const status =
        error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
      return errorResponse(status, error.code, error.message, requestId);
    }
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  const access = await authorize(request, requestId);
  if ("response" in access) {
    return access.response;
  }

  const { id } = await context.params;
  if (!validId(id)) {
    return errorResponse(
      400,
      "validation_error",
      "Идентификатор статьи не является UUID",
      requestId,
    );
  }

  try {
    await deleteArticleDraft(access.tenantId, id);
    return NextResponse.json(
      { status: "deleted" },
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof ArticleDraftError) {
      const status =
        error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
      return errorResponse(status, error.code, error.message, requestId);
    }
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }
}
