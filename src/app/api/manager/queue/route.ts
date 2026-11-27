import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { accessHttpStatus, checkManagerAccess } from "@/modules/access";
import { listPromises, type PromiseRecord } from "@/modules/promises";

/** Тело ответа очереди — snake_case по контракту внешнего HTTP API. */
type QueueStep = {
  node: string;
  endpoint: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: string;
  latency_ms: number;
  created_at: string;
};

type QueuePromise = {
  id: string;
  conversation_id: string;
  text: string;
  due_at: string;
  owner: string;
  status: string;
};

type QueueItem = {
  id: string;
  conversation_id: string;
  reason: string;
  summary: string;
  draft: string | null;
  sources: unknown[];
  status: string;
  sla_due_at: string | null;
  overdue: boolean;
  created_at: string;
  channel: string;
  result: string;
  trace_ref: string;
  is_shadow: boolean;
  steps: QueueStep[];
  promises: QueuePromise[];
};

type EscalationRow = {
  id: string;
  conversation_id: string;
  reason: string;
  summary: string;
  draft: string | null;
  sources: unknown[];
  status: string;
  sla_due_at: Date | null;
  created_at: Date;
  channel: string;
  result: string;
  trace_ref: string;
  is_shadow: boolean;
};

type AgentStepRow = {
  conversation_id: string;
  node: string;
  endpoint: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: string;
  latency_ms: number;
  created_at: Date;
};

function errorResponse(status: number, code: string, message: string, requestId: string): Response {
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

function promiseView(record: PromiseRecord): QueuePromise {
  return {
    id: record.id,
    conversation_id: record.conversationId,
    text: record.text,
    due_at: record.dueAt,
    owner: record.owner,
    status: record.status,
  };
}

/**
 * GET /api/manager/queue — данные очереди обращений и журнала обещаний.
 *
 * Кабинет закрыт cookie `support_manager`. Арендатор определяется сервером
 * из окружения и не принимается из тела запроса.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const access = await checkManagerAccess({ cookieHeader: request.headers.get("cookie") });
  if (!access.allowed) {
    return errorResponse(
      accessHttpStatus(access),
      "unauthorized",
      "Требуется доступ менеджера",
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
    const escalations = await getPool().query<EscalationRow>(
      `SELECT id, conversation_id, reason, summary, draft, sources, status,
              sla_due_at, created_at, channel, result, trace_ref, is_shadow
         FROM escalations
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC`,
      [tenantId],
    );

    const conversationIds = escalations.rows.map((row) => row.conversation_id);
    const steps =
      conversationIds.length === 0
        ? { rows: [] as AgentStepRow[] }
        : await getPool().query<AgentStepRow>(
            `SELECT conversation_id, node, endpoint, tokens_in, tokens_out,
                    cost_rub, latency_ms, created_at
               FROM agent_steps
              WHERE tenant_id = $1
                AND conversation_id = ANY($2::uuid[])
              ORDER BY conversation_id, created_at ASC, id ASC`,
            [tenantId, conversationIds],
          );

    const records = await listPromises({ tenantId });
    const promiseItems = records.map(promiseView);
    const stepsByConversation = new Map<string, QueueStep[]>();
    for (const row of steps.rows) {
      const items = stepsByConversation.get(row.conversation_id) ?? [];
      items.push({
        node: row.node,
        endpoint: row.endpoint,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        cost_rub: row.cost_rub,
        latency_ms: row.latency_ms,
        created_at: row.created_at.toISOString(),
      });
      stepsByConversation.set(row.conversation_id, items);
    }
    const promisesByConversation = new Map<string, QueuePromise[]>();
    for (const promise of promiseItems) {
      const items = promisesByConversation.get(promise.conversation_id) ?? [];
      items.push(promise);
      promisesByConversation.set(promise.conversation_id, items);
    }

    const now = Date.now();
    const items: QueueItem[] = escalations.rows.map((row) => ({
      id: row.id,
      conversation_id: row.conversation_id,
      reason: row.reason,
      summary: row.summary,
      draft: row.draft,
      sources: row.sources,
      status: row.status,
      sla_due_at: row.sla_due_at?.toISOString() ?? null,
      // Просрочка считается сервером по сроку SLA, а не отдельным статусом
      // в базе: набор статусов `escalations` ограничен ('open','closed'),
      // и менеджеру нужен признак «просрочено» без изменения схемы.
      overdue:
        row.status === "overdue" ||
        (row.status === "open" &&
          row.sla_due_at !== null &&
          row.sla_due_at.getTime() < now),
      created_at: row.created_at.toISOString(),
      channel: row.channel,
      result: row.result,
      trace_ref: row.trace_ref,
      is_shadow: row.is_shadow,
      steps: stepsByConversation.get(row.conversation_id) ?? [],
      promises: promisesByConversation.get(row.conversation_id) ?? [],
    }));

    return Response.json({ items, promises: promiseItems });
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "База данных недоступна",
      requestId,
    );
  }
}
