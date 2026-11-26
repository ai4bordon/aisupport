import { randomUUID } from "node:crypto";
import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { runAgent } from "@/core/run";
import type { NormalizedMessage } from "@/core/run";

/**
 * POST /agent/run — запуск агентного цикла для нормализованного сообщения
 * (docs/api-contract.md §5).
 *
 * Текст приходит уже замаскированным: ядро не знает интерфейсов каналов.
 */
type AgentRunRequest = {
  conversation_id: string;
  message_id: string;
  channel: "web" | "max";
  external_chat_id: string | null;
  text: string;
  masked_fields_count: number;
};

export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: "validation_error",
          message: "Тело запроса не разобрано",
          details: {},
          request_id: requestId,
        },
      },
      { status: 400 },
    );
  }

  const body = payload as Partial<AgentRunRequest>;
  const valid =
    typeof body.conversation_id === "string" &&
    typeof body.message_id === "string" &&
    (body.channel === "web" || body.channel === "max") &&
    typeof body.text === "string" &&
    typeof body.masked_fields_count === "number";

  if (!valid) {
    return Response.json(
      {
        error: {
          code: "validation_error",
          message: "Тело запроса не прошло схему",
          details: {},
          request_id: requestId,
        },
      },
      { status: 400 },
    );
  }

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return Response.json(
      {
        error: {
          code: "upstream_unavailable",
          message: "База данных недоступна",
          details: {},
          request_id: requestId,
        },
      },
      { status: 503 },
    );
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO conversations (id, tenant_id, channel, external_chat_id, status)
     VALUES ($1, $2, $3, $4, 'open')
     ON CONFLICT (id) DO NOTHING`,
    [body.conversation_id, tenantId, body.channel, body.external_chat_id ?? null],
  );

  const input: NormalizedMessage = {
    conversationId: body.conversation_id as string,
    messageId: body.message_id as string,
    channel: body.channel as "web" | "max",
    externalChatId: body.external_chat_id ?? null,
    text: body.text as string,
    maskedFieldsCount: body.masked_fields_count as number,
    tenantId,
  };

  const outcome = await runAgent(input);

  return Response.json({
    outcome: outcome.outcome,
    answer:
      outcome.outcome === "respond"
        ? {
            text: outcome.answer.text,
            sources: outcome.answer.sources.map((source) => ({
              kind: source.kind,
              id: source.id,
              title: source.title,
              location: source.location,
            })),
          }
        : null,
    escalation:
      outcome.outcome === "escalate" ? outcome.escalation : null,
    steps: outcome.steps.map((step) => ({
      node: step.node,
      endpoint: step.endpoint,
      latency_ms: step.latencyMs,
      tokens_in: step.tokensIn,
      tokens_out: step.tokensOut,
      cost_rub: step.costRub,
      source_ids: step.sourceIds,
      outcome: step.outcome,
      model: step.model,
    })),
  });
}
