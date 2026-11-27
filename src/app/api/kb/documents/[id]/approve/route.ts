import { randomUUID } from "node:crypto";

import { getTenantId } from "@/db/tenant";
import { checkManagerAccess } from "@/modules/access";
import {
  KnowledgeDocumentError,
  approveDocument,
  documentHttpStatus,
} from "@/modules/document-upload";

/**
 * POST /kb/documents/{id}/approve — одобрение документа базы знаний
 * (docs/api-contract.md §6).
 *
 * Одобрение переводит `pending → published`: индекс уже готов, одобрение
 * лишь открывает материал поиску. Повторное одобрение — `409 conflict`.
 * Документ чужого арендатора выглядит как отсутствующий: `404 not_found`.
 */

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        details,
        request_id: randomUUID(),
      },
    },
    { status },
  );
}

/** Тело запроса: кто одобряет. */
type ApproveBody = { actor: string };

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const decision = await checkManagerAccess({
    cookieHeader: request.headers.get("cookie"),
  });
  if (!decision.allowed) {
    return errorResponse(401, "unauthorized", "Код доступа менеджера не принят");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Тело запроса не разобрано");
  }

  const actor =
    typeof body === "object" && body !== null && "actor" in body
      ? (body as ApproveBody).actor
      : undefined;
  if (typeof actor !== "string" || actor.length === 0) {
    return errorResponse(400, "validation_error", "Поле actor обязательно");
  }

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return errorResponse(503, "upstream_unavailable", "База данных недоступна");
  }

  const { id } = await context.params;

  try {
    const record = await approveDocument(tenantId, id, actor);
    return Response.json(
      {
        id: record.id,
        status: record.status,
        filename: record.filename,
        mime_type: record.mimeType,
        chunks_count: record.chunksCount,
        approved_by: record.approvedBy,
        approved_at: record.approvedAt,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof KnowledgeDocumentError) {
      return errorResponse(documentHttpStatus(error.code), error.code, error.message, {
        field: error.field,
      });
    }
    return errorResponse(500, "internal_error", "Не удалось одобрить документ");
  }
}
