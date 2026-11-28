import { randomUUID } from "node:crypto";
import { getTenantId } from "@/db/tenant";
import { readAccessSession } from "@/modules/access";
import { listAuditEntries } from "@/modules/agent-settings";

/**
 * `GET /audit` — аудит изменений настроек (docs/api-contract.md §3).
 *
 * Путь зафиксирован контрактом: «Аудит изменений настроек», приоритет
 * «Тикет настроек». Ответ без правки `next.config.ts`.
 *
 * Барьер кабинета менеджера — тот же, что у остальных маршрутов менеджера
 * (docs/api-contract.md §11.1).
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
  // Браузерный запрос ведём на человекочитаемую страницу журнала: JSON
  // в адресной строке выглядел как сбой, и без сессии клиент получал
  // голый ответ с ошибкой. Контрактный JSON для программных клиентов
  // остаётся: путь зафиксирован в docs/api-contract.md §3.
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return new Response(null, {
      status: 307,
      headers: { location: "/manager/audit" },
    });
  }

  if (readAccessSession(request.headers.get("cookie") ?? undefined) === null) {
    return errorResponse(401, "unauthorized", "Кабинет закрыт: нужен код доступа");
  }

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = limitParam === null ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return errorResponse(400, "validation_error", "Параметр limit должен быть целым от 1 до 200");
  }

  try {
    const tenantId = await getTenantId();
    const entries = await listAuditEntries(tenantId, limit);
    return Response.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        actor: entry.actor,
        action: entry.action,
        entity: entry.entity,
        key: entry.key,
        before: entry.before,
        after: entry.after,
        created_at: new Date(entry.createdAt).toISOString(),
      })),
    });
  } catch {
    return errorResponse(503, "upstream_unavailable", "База данных недоступна");
  }
}
