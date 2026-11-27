import { randomUUID } from "node:crypto";
import { getTenantId } from "@/db/tenant";
import { readAccessSession } from "@/modules/access";
import { listTestSessions } from "@/modules/agent-settings";

/**
 * `GET /api/settings/history` — история тестовых сессий (R12).
 *
 * Путь новый: в таблице `docs/api-contract.md` §3 его нет, регистрация —
 * запрос на ревизию контракта к exec.
 *
 * В выборке нет секретов и сырых персональных данных: запрос хранится
 * маскированным, конфигурация — без секретных полей.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: { code, message, details: {}, request_id: randomUUID() },
    }),
    { status, headers: JSON_HEADERS },
  );
}

export async function GET(request: Request): Promise<Response> {
  if (readAccessSession(request.headers.get("cookie") ?? undefined) === null) {
    return errorResponse(401, "unauthorized", "Кабинет менеджера закрыт: нужен код менеджера");
  }

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = limitParam === null ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return errorResponse(400, "validation_error", "Параметр limit должен быть целым от 1 до 200");
  }

  try {
    const tenantId = await getTenantId();
    const sessions = await listTestSessions(tenantId, limit);
    return Response.json({
      sessions: sessions.map((session) => ({
        session_id: session.sessionId,
        settings_version: session.settingsVersion,
        settings_snapshot: session.settingsSnapshot,
        request_text_masked: session.requestTextMasked,
        result: {
          outcome: session.result.outcome,
          answer: session.result.answer,
          grade: session.result.grade,
          sources: session.result.sources,
        },
        tokens_in: session.tokensIn,
        tokens_out: session.tokensOut,
        cost_rub: session.costRub,
        actor: session.actor,
        created_at: new Date(session.createdAt).toISOString(),
      })),
    });
  } catch {
    return errorResponse(503, "upstream_unavailable", "База данных недоступна");
  }
}
