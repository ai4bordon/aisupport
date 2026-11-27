import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { checkManagerAccess, accessHttpStatus } from "@/modules/access";
import { getTenantId } from "@/db/tenant";
import {
  approveAndPublishArticleDraft,
  ArticleDraftError,
} from "@/modules/article-drafts";

/**
 * `POST /kb/drafts/{id}/approve` — одобрение и публикация черновика статьи.
 *
 * Контракт заморожен: ответ `200` содержит сущность в статусе `published`.
 * Внутри сохраняются два явных перехода — `pending_review → approved →
 * published`, — выполненные в одной транзакции, и отдельный от документного
 * потока: операции загрузки документов этот маршрут не вызывает (ADR-0005).
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const approveSchema = z.object({
  actor: z.string().min(1).max(200),
});

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        details,
        request_id: randomUUID(),
      },
    },
    { status, headers: JSON_HEADERS },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const decision = await checkManagerAccess({
    cookieHeader: request.headers.get("cookie"),
  });
  if (!decision.allowed) {
    return errorResponse(
      accessHttpStatus(decision),
      "unauthorized",
      "Операции со статьями доступны только менеджеру",
    );
  }

  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return errorResponse(400, "validation_error", "Идентификатор статьи не является UUID");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Тело запроса не разобрано");
  }

  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "validation_error", "В теле запроса обязателен actor", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const tenantId = await getTenantId();
    const draft = await approveAndPublishArticleDraft({
      tenantId,
      id,
      actor: parsed.data.actor,
    });

    return NextResponse.json(
      {
        id: draft.id,
        status: draft.status,
        conversation_id: draft.conversationId,
        source_message_ids: draft.sourceMessageIds,
        source_excerpt: draft.sourceExcerpt,
        title: draft.title,
        body_md: draft.bodyMd,
        approved_by: draft.approvedBy,
        approved_at: draft.approvedAt?.toISOString() ?? null,
        reviewed_at: draft.reviewedAt?.toISOString() ?? null,
        published_at: draft.publishedAt?.toISOString() ?? null,
      },
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof ArticleDraftError) {
      const status = error.code === "validation_error" ? 400 : error.code === "not_found" ? 404 : 409;
      return errorResponse(status, error.code, error.message);
    }
    return errorResponse(500, "internal_error", "Не удалось одобрить черновик статьи");
  }
}
