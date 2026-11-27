import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { checkManagerAccess, accessHttpStatus, readAccessSession } from "@/modules/access";
import { getTenantId } from "@/db/tenant";
import {
  approveAndPublishArticleDraft,
  createArticleDraft,
  ArticleDraftError,
} from "@/modules/article-drafts";

/**
 * `POST /kb/drafts` — создание черновика статьи из материала диалога.
 *
 * Маршрут живой: арендатор определяется сервером, а из тела запроса не
 * принимается. Барьер `checkManagerAccess` проверяется до бизнес-логики, и
 * клиентская cookie стенда в кабинет менеджера не пускает (R17).
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const draftSchema = z.object({
  conversation_id: z.uuid(),
  source_message_ids: z.array(z.uuid()).min(1),
  source_excerpt: z.string().min(1).max(4000).nullable().optional(),
  title: z.string().min(1).max(500),
  body_md: z.string().min(1).max(100_000),
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

export async function POST(request: Request): Promise<NextResponse> {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Тело запроса не разобрано");
  }

  const parsed = draftSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "validation_error", "Тело запроса не прошло схему", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const tenantId = await getTenantId();
    // Автор материала — сессия доступа: тело запроса автора не подменяет.
    const session = readAccessSession(request.headers.get("cookie"));
    const draft = await createArticleDraft({
      tenantId,
      actor: session?.sessionId ?? "manager",
      conversationId: parsed.data.conversation_id,
      sourceMessageIds: parsed.data.source_message_ids,
      sourceExcerpt: parsed.data.source_excerpt ?? null,
      title: parsed.data.title,
      bodyMd: parsed.data.body_md,
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
        created_at: draft.createdAt.toISOString(),
      },
      { status: 201, headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof ArticleDraftError) {
      const status = error.code === "validation_error" ? 400 : error.code === "not_found" ? 404 : 409;
      return errorResponse(status, error.code, error.message);
    }
    return errorResponse(500, "internal_error", "Не удалось создать черновик статьи");
  }
}
