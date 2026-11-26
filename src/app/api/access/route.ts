import { randomUUID } from "node:crypto";
import { buildAccessCookie } from "@/modules/access/session";
import { verifyAccessCode } from "@/modules/access";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        details: {},
        request_id: randomUUID(),
      },
    }),
    { status, headers: JSON_HEADERS },
  );
}

/**
 * Проверка кода доступа и выдача подписанной cookie `support_access`.
 *
 * Код доступа приходит в теле запроса, сверяется с `ACCESS_CODE` без утечки
 * времени и в ответе не возвращается. Код и его отпечаток не попадают ни в
 * cookie, ни в тело ответа, ни в журнал.
 */
export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Ожидается JSON с полем code");
  }

  const code =
    typeof payload === "object" && payload !== null && "code" in payload
      ? payload.code
      : undefined;

  if (typeof code !== "string" || code.length === 0) {
    return errorResponse(400, "validation_error", "Поле code обязательно");
  }

  const session = await verifyAccessCode(code);
  if (!session) {
    return errorResponse(401, "unauthorized", "Код доступа не принят");
  }

  return new Response(
    JSON.stringify({
      session_id: session.sessionId,
      expires_at: new Date(session.expiresAt).toISOString(),
    }),
    {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        "set-cookie": buildAccessCookie(session),
      },
    },
  );
}
