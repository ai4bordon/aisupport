import { randomUUID } from "node:crypto";
import {
  buildAccessCookie,
  buildManagerCookie,
  currentManagerCode,
  verifyAccessCode,
  verifyManagerCode,
} from "@/modules/access/session";

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
 * `manager: true` — вход в кабинет менеджера: выдаётся отдельная cookie
 * `support_manager`. Без флага — вход на стенд, cookie `support_access`.
 */
type AccessPayload = {
  code: string;
  manager: boolean;
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
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const code = record.code;
    const manager = record.manager;
    if (typeof code !== "string" || code.length === 0) {
      return null;
    }
    if (manager !== undefined && typeof manager !== "boolean") {
      return null;
    }
    return { code, manager: manager === true };
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
  const manager = form.get("manager");
  if (manager !== null && manager !== "true" && manager !== "on") {
    return null;
  }
  return { code, manager: manager === "true" || manager === "on" };
}

/**
 * Проверка кода доступа и выдача подписанной cookie.
 *
 * Код доступа приходит в теле запроса, сверяется с `ACCESS_CODE` без утечки
 * времени и в ответе не возвращается. Код и его отпечаток не попадают ни в
 * cookie, ни в тело ответа, ни в журнал.
 *
 * Для кабинета менеджера код сверяется с `MANAGER_ACCESS_CODE` — отдельным
 * кодом; если он в окружении не задан, кабинет закрыт (`403 forbidden`).
 */
export async function POST(request: Request): Promise<Response> {
  const payload = await readPayload(request);
  if (!payload) {
    return errorResponse(400, "validation_error", "Ожидается code: JSON или форма");
  }

  if (payload.manager) {
    if (currentManagerCode() === null) {
      return errorResponse(
        403,
        "forbidden",
        "Кабинет менеджера недоступен: код менеджера не задан",
      );
    }

    const managerSession = await verifyManagerCode(payload.code);
    if (!managerSession) {
      return errorResponse(401, "unauthorized", "Код доступа менеджера не принят");
    }

    return new Response(
      JSON.stringify({
        session_id: managerSession.sessionId,
        expires_at: new Date(managerSession.expiresAt).toISOString(),
      }),
      {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          "set-cookie": buildManagerCookie(managerSession),
        },
      },
    );
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
