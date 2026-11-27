import { randomUUID } from "node:crypto";
import { getTenantId } from "@/db/tenant";
import { readAccessSession } from "@/modules/access";

import {
  describeCapabilities,
  readCurrentSettings,
  readShadowMode,
  SettingsError,
  updateSetting,
  type SettingsKey,
} from "@/modules/agent-settings";

/**
 * `GET /api/settings` и `PUT /api/settings` — конфигурация агента (R12).
 *
 * Путь новый: в таблице `docs/api-contract.md` §3 его нет, регистрация —
 * запрос на ревизию контракта к exec.
 *
 * Арендатор определяется сервером и не принимается из тела запроса
 * (docs/api-contract.md §1). Тело и ответ — в `snake_case` (§2).
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

/**
 * Барьер кабинета менеджера.
 *
 * Тот же барьер, что у остальных маршрутов менеджера: подписанная cookie
 * `support_manager` (docs/api-contract.md §11.1). Cookie стенда в кабинет
 * не пускает.
 */
function managerAllowed(request: Request): boolean {
  return readAccessSession(request.headers.get("cookie") ?? undefined) !== null;
}

/** Текущая версия конфигурации и реестр возможностей. */
export async function GET(request: Request): Promise<Response> {
  if (!managerAllowed(request)) {
    return errorResponse(401, "unauthorized", "Кабинет менеджера закрыт: нужен код менеджера");
  }

  try {
    const tenantId = await getTenantId();
    const [settings, shadowMode] = await Promise.all([
      readCurrentSettings(tenantId),
      readShadowMode(tenantId),
    ]);
    return Response.json({
      version: settings.version,
      provider: settings.provider,
      model: settings.model,
      endpoint: settings.endpoint,
      system_prompt: settings.systemPrompt,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      shadow_mode: shadowMode,
      created_at: settings.createdAt,
      capabilities: describeCapabilities().map((capability) => ({
        key: capability.key,
        label: capability.label,
        supported: capability.supported,
        reason: capability.reason,
        control: capability.control,
      })),
    });
  } catch {
    return errorResponse(503, "upstream_unavailable", "База данных недоступна");
  }
}

/** Изменение поддерживаемой настройки: новая версия и запись аудита. */
export async function PUT(request: Request): Promise<Response> {
  if (!managerAllowed(request)) {
    return errorResponse(401, "unauthorized", "Кабинет менеджера закрыт: нужен код менеджера");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Ожидается JSON с полями key и value");
  }
  if (typeof payload !== "object" || payload === null) {
    return errorResponse(400, "validation_error", "Ожидается JSON с полями key и value");
  }
  const record = payload as Record<string, unknown>;
  const key = record["key"];
  if (typeof key !== "string" || key.length === 0) {
    return errorResponse(400, "validation_error", "Поле key обязательно");
  }
  if (!("value" in record)) {
    return errorResponse(400, "validation_error", "Поле value обязательно");
  }
  const actor =
    typeof record["actor"] === "string" && record["actor"].length > 0
      ? record["actor"]
      : "manager";

  try {
    const tenantId = await getTenantId();
    const settings = await updateSetting(
      tenantId,
      key,
      record["value"],
      actor,
    );
    return Response.json({
      version: settings.version,
      provider: settings.provider,
      model: settings.model,
      endpoint: settings.endpoint,
      system_prompt: settings.systemPrompt,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      created_at: settings.createdAt,
    });
  } catch (error) {
    if (error instanceof SettingsError) {
      const status = error.code === "not_implemented" ? 422 : 400;
      return errorResponse(status, error.code, error.message);
    }
    return errorResponse(500, "internal_error", "Настройку сохранить не удалось");
  }
}

/** Ключи настройки, принимаемые модулем. */
export type { SettingsKey };
