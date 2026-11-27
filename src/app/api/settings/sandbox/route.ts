import { randomUUID } from "node:crypto";
import { getTenantId } from "@/db/tenant";
import { readAccessSession } from "@/modules/access";
import { ModelTimeoutError, ModelUnavailableError } from "@/core/model";
import { runSandbox } from "@/modules/agent-settings";

/**
 * `POST /api/settings/sandbox` — изолированная тестовая сессия (R12).
 *
 * Путь новый: в таблице `docs/api-contract.md` §3 его нет, регистрация —
 * запрос на ревизию контракта к exec.
 *
 * Песочница не отправляет сообщения в веб-чат и MAX, не меняет клиентские
 * диалоги и не влияет на аналитику рабочего окружения: результат видит только
 * менеджер, в истории тестовых сессий.
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

export async function POST(request: Request): Promise<Response> {
  if (readAccessSession(request.headers.get("cookie") ?? undefined) === null) {
    return errorResponse(401, "unauthorized", "Кабинет менеджера закрыт: нужен код менеджера");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Ожидается JSON с полем text");
  }
  if (typeof payload !== "object" || payload === null) {
    return errorResponse(400, "validation_error", "Ожидается JSON с полем text");
  }
  const record = payload as Record<string, unknown>;
  const text = record["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    return errorResponse(400, "validation_error", "Поле text обязательно");
  }
  if (text.length > 4000) {
    return errorResponse(413, "payload_too_large", "Вопрос ограничен 4000 символами");
  }
  const actor =
    typeof record["actor"] === "string" && record["actor"].length > 0
      ? record["actor"]
      : "manager";
  const version = record["settings_version"];
  if (
    version !== undefined &&
    (typeof version !== "number" || !Number.isInteger(version) || version < 1)
  ) {
    return errorResponse(400, "validation_error", "Поле settings_version должно быть целым числом");
  }

  try {
    const tenantId = await getTenantId();
    const result = await runSandbox({
      tenantId,
      actor,
      text,
      ...(typeof version === "number" ? { settingsVersion: version } : {}),
    });
    return Response.json({
      session_id: result.sessionId,
      settings_version: result.settingsVersion,
      outcome: result.outcome,
      grade: result.grade,
      answer: result.answer,
      sources: result.sources.map((source) => ({
        kind: source.kind,
        id: source.id,
        title: source.title,
        location: source.location,
      })),
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_rub: result.costRub,
      trace: result.trace.map((step) => ({
        node: step.node,
        latency_ms: step.latencyMs,
        tokens_in: step.tokensIn,
        tokens_out: step.tokensOut,
        cost_rub: step.costRub,
        detail: step.detail,
      })),
    });
  } catch (error) {
    // Отказ провайдера модели — внешний API, а не база: по таблице ошибок
    // контракта §2 это `upstream_error` (502), а не `upstream_unavailable`.
    if (
      error instanceof ModelUnavailableError ||
      error instanceof ModelTimeoutError
    ) {
      return errorResponse(502, "upstream_error", error.message);
    }
    return errorResponse(503, "upstream_unavailable", "Песочница недоступна");
  }
}
