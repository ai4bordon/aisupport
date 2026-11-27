import { getTenantId } from "@/db/tenant";
import { accessHttpStatus, checkManagerAccess } from "@/modules/access";
import { ArticleDraftError } from "@/modules/article-drafts";
import {
  defaultAnswerTitle,
  rememberAnswer,
} from "@/modules/manager-memory";

/**
 * POST /api/manager/queue/remember — действие «запомнить ответ».
 *
 * Ответ менеджера, сохранённый этим действием, сам является одобрением:
 * он сразу попадает в общий поиск с исходным обращением как источником
 * (R7, R12, ADR-0019). Отдельного одобрения старшего и срока устаревания
 * не требуется.
 *
 * Кабинет закрыт cookie `support_manager`. Арендатор определяется сервером
 * и не принимается из тела запроса.
 */

type RememberBody = {
  conversation_id?: string;
  title?: string;
  body_md?: string;
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

export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
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

  let body: RememberBody;
  try {
    body = (await request.json()) as RememberBody;
  } catch {
    return errorResponse(
      400,
      "validation_error",
      "Тело запроса не разобрано",
      requestId,
    );
  }

  const conversationId = body.conversation_id?.trim() ?? "";
  const bodyMd = body.body_md?.trim() ?? "";
  if (conversationId.length === 0 || bodyMd.length === 0) {
    return errorResponse(
      400,
      "validation_error",
      "Нужны диалог и текст ответа",
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
    const title = body.title?.trim() ?? "";
    const remembered = await rememberAnswer({
      tenantId,
      actor: "manager",
      conversationId,
      title: title.length > 0 ? title : defaultAnswerTitle(bodyMd),
      bodyMd,
    });

    return Response.json(
      {
        article_id: remembered.articleId,
        title: remembered.title,
        status: remembered.status,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof ArticleDraftError) {
      const status = error.code === "not_found" ? 404 : 422;
      return errorResponse(status, error.code, error.message, requestId);
    }
    return errorResponse(
      500,
      "internal_error",
      "Не удалось сохранить ответ",
      requestId,
    );
  }
}
