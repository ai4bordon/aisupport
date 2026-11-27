import { getTenantId } from "@/db/tenant";
import { markPromiseDone } from "@/modules/promises";

/**
 * POST /promises/{id}/done — менеджер отмечает «отправил» (ADR-0018).
 *
 * Письма не отправляются: ни SMTP, ни CRM, ни MAX из маршрута не
 * вызываются, `reminded_at` не заполняется. Меняется только статус записи:
 * менеджер сам готовит документ и подтверждает отправку.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { id } = await context.params;

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return Response.json(
      {
        error: {
          code: "upstream_unavailable",
          message: "База данных недоступна",
          details: {},
          request_id: requestId,
        },
      },
      { status: 503 },
    );
  }

  try {
    const changed = await markPromiseDone(id, tenantId);
    if (!changed) {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: "Обещание не найдено",
            details: {},
            request_id: requestId,
          },
        },
        { status: 404 },
      );
    }
    return Response.json({ id, status: "done" });
  } catch {
    return Response.json(
      {
        error: {
          code: "upstream_unavailable",
          message: "База данных недоступна",
          details: {},
          request_id: requestId,
        },
      },
      { status: 503 },
    );
  }
}
