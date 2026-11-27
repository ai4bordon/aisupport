import { getTenantId } from "@/db/tenant";
import {
  listPromises,
  recordPromise,
  type PromiseRecord,
  type PromiseStatus,
} from "@/modules/promises";

/**
 * GET /promises — журнал обещаний менеджера (docs/api-contract.md §3).
 *
 * Журнал перечисляет открытые, выполненные и просроченные обещания с
 * явными каналом и адресатом. Арендатор определяется сервером, из запроса
 * не принимается.
 *
 * Реальной отправки писем нет: ни SMTP, ни CRM, ни MAX из маршрута не
 * вызываются, `reminded_at` не заполняется. Менеджер видит обещание,
 * готовит документ и отмечает «отправил» руками — действие
 * `POST /promises/{id}/done` переводит запись в статус `done`.
 */

/** Статусы, которые можно запросить фильтром. */
const STATUSES: PromiseStatus[] = ["open", "done", "overdue"];

/** Пометка происхождения записи для менеджера. */
const ORIGIN_CONFIRMED = "подтверждённый источник";
const ORIGIN_SYNTHETIC = "синтетический/демонстрационный";

/** Тело ответа — snake_case по §2 контракта. */
type PromiseView = {
  id: string;
  conversation_id: string;
  text: string;
  due_at: string;
  owner: string;
  status: PromiseStatus;
  source_kind: string | null;
  source_id: string | null;
  channel: string;
  contact: string | null;
  contact_label: string | null;
  origin: string;
  is_synthetic: boolean;
  overdue: boolean;
  reminded_at: string | null;
  created_at: string;
};

/**
 * Адресат обещания.
 *
 * В MAX это диалог, в веб-чате — адрес клиента: обещание без адресата
 * менеджеру некуда выполнять.
 */
function contactOf(record: PromiseRecord): string | null {
  return record.channel === "email" ? record.contactEmail : record.externalChatId;
}

function toView(record: PromiseRecord): PromiseView {
  return {
    id: record.id,
    conversation_id: record.conversationId,
    text: record.text,
    due_at: record.dueAt,
    owner: record.owner,
    status: record.status,
    source_kind: record.sourceKind,
    source_id: record.sourceId,
    channel: record.channel,
    contact: contactOf(record),
    contact_label: record.contactLabel,
    // Пометка синтетической записи видимая: демо-строка не должна
    // выглядеть как реальное обязательство клиенту.
    origin: record.isSynthetic ? ORIGIN_SYNTHETIC : ORIGIN_CONFIRMED,
    is_synthetic: record.isSynthetic,
    // Признак просрочки — в данных, а не в стилизации: кабинет подсвечивает
    // запись по нему.
    overdue: record.status === "overdue",
    reminded_at: record.remindedAt,
    created_at: record.createdAt,
  };
}

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

export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");

  if (statusParam !== null && !STATUSES.includes(statusParam as PromiseStatus)) {
    return errorResponse(
      400,
      "validation_error",
      "Параметр status должен быть одним из open, done, overdue",
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
    const records = await listPromises({
      tenantId,
      status: statusParam === null ? undefined : (statusParam as PromiseStatus),
    });
    return Response.json({ promises: records.map(toView) });
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }
}

/**
 * POST /promises — ручное создание обещания менеджером.
 *
 * Внешних вызовов нет: запись создаётся в журнале, документ менеджер
 * готовит сам. Арендатор определяется сервером.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Тело запроса не разобрано", requestId);
  }

  const body = payload as {
    conversation_id?: string;
    text?: string;
    due_at?: string;
    owner?: string;
    channel?: string;
    contact?: string;
  };

  const text = body.text?.trim() ?? "";
  const dueAt = body.due_at ?? "";
  const owner = body.owner?.trim() ?? "";
  const conversationId = body.conversation_id ?? "";

  if (
    text.length === 0 ||
    owner.length === 0 ||
    conversationId.length === 0 ||
    Number.isNaN(Date.parse(dueAt))
  ) {
    return errorResponse(
      400,
      "validation_error",
      "Нужны conversation_id, text, due_at и owner",
      requestId,
    );
  }

  const channel = body.channel === "email" ? "email" : "max";

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
    const record = await recordPromise({
      tenantId,
      conversationId,
      text,
      dueAt: new Date(dueAt).toISOString(),
      owner,
      channel,
      contactEmail: channel === "email" ? (body.contact ?? null) : null,
      externalChatId: channel === "max" ? (body.contact ?? null) : null,
      // Запись, созданная менеджером вручную, помечается синтетической:
      // подтверждённого источника у неё нет.
      isSynthetic: true,
    });
    return Response.json({ promise: toView(record) });
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }
}
