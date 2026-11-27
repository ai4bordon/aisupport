import { randomUUID } from "node:crypto";
import { buildAccessCookie, verifyAccessCode } from "@/modules/access/session";

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
 * Тело запроса входа.
 *
 * Код один — `ACCESS_CODE`, и одна cookie `support_access` на весь стенд:
 * чат, MAX и кабинет менеджера. Раздельные коды для клиента и менеджера
 * заводить позже, когда заказчик возьмёт стенд (решение владельца
 * от 28.11.2026).
 */
type AccessPayload = {
  code: string;
};

/**
 * Тело запроса: принимаются и JSON, и обычная форма.
 *
 * Страница `/access` шлёт JSON через `fetch`, но нативная отправка формы
 * (`application/x-www-form-urlencoded`) тоже должна работать: стороны не
 * должны расходиться в формате (BUGSAUDIT-2026-11-27.md, A2).
 */
async function readPayload(request: Request): Promise<AccessPayload | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return null;
    }
    // Тело запроса — внешние данные: код вычитывается через проверку типа,
    // а не через утверждение о форме.
    if (typeof body !== "object" || body === null || !("code" in body)) {
      return null;
    }
    const code = body.code;
    if (typeof code !== "string" || code.length === 0) {
      return null;
    }
    return { code };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return null;
  }
  const code = form.get("code");
  if (typeof code !== "string" || code.length === 0) {
    return null;
  }
  return { code };
}

/**
 * Проверка кода доступа и выдача подписанной cookie.
 *
 * Код доступа приходит в теле запроса, сверяется с `ACCESS_CODE` без утечки
 * времени и в ответе не возвращается. Код и его отпечаток не попадают ни в
 * cookie, ни в тело ответа, ни в журнал.
 *
 * Cookie одна на весь стенд: `support_access` открывает и чат, и кабинет
 * менеджера. Отдельный код менеджера (ADR-0017) для демо не нужен —
 * решение владельца от 28.11.2026.
 */
export async function POST(request: Request): Promise<Response> {
  const payload = await readPayload(request);
  if (!payload) {
    return errorResponse(400, "validation_error", "Ожидается code: JSON или форма");
  }

  const session = await verifyAccessCode(payload.code);
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
