import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ChatRequestSchema } from "@/contracts/chat";
import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { maskPersonalData, restoreMaskedData } from "@/core/mask";
import { createsManagerQueue } from "@/core/escalation-mode";
import { runAgent } from "@/core/run";
import { buildSetCookie, readConversationId } from "@/core/session";
import {
  isShadowMode,
  recordManagerQueue,
  recordShadowDraft,
  SHADOW_REASON,
} from "@/core/shadow-mode";
import { validateOutgoingText } from "@/core/validate";

/**
 * POST /v1/chat — веб-чат (docs/api-contract.md §4).
 *
 * Порядок: cookie → сверка conversation_id → маскирование → ядро →
 * восстановление меток → запись в базу → ответ по контракту.
 *
 * Идентификация по IP не используется: диалог определяется только
 * подписанной cookie.
 */

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return Response.json(
    { error: { code, message, details: {}, request_id: requestId } },
    { status },
  );
}

export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(
      400,
      "validation_error",
      "Тело запроса не разобрано",
      requestId,
    );
  }

  const parsed = ChatRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "validation_error",
      "Тело запроса не прошло схему",
      requestId,
    );
  }
  const body = parsed.data;

  // Диалог определяется подписанной cookie; тело только сверяется с ней.
  const cookieConversation = readConversationId(request.headers.get("cookie") ?? undefined);
  if (cookieConversation && cookieConversation.id !== body.conversation_id) {
    return errorResponse(
      403,
      "forbidden",
      "conversation_id не совпадает с подписанной cookie",
      requestId,
    );
  }

  const conversationId = cookieConversation?.id ?? body.conversation_id;
  const isNewConversation = cookieConversation === null;

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

  const pool = getPool();

  // Режим тени снимается один раз в начале обработки и действует на неё
  // целиком: переключение настройки посередине обработки не должно менять
  // её исход (docs/plans/06-shadow-mode.md, шаг 4).
  const shadowMode = await isShadowMode(pool, tenantId);

  // Идемпотентность: повтор client_message_id не создаёт второе обращение.
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM messages WHERE tenant_id = $1 AND client_message_id = $2 AND role = 'client'",
    [tenantId, body.message.client_message_id],
  );
  const existingMessage = existing.rows[0];

  if (existingMessage) {
    const previous = await pool.query<{
      id: string;
      outcome: string;
      text_masked: string;
      sources: unknown;
    }>(
      `SELECT m.id, m.text_masked, m.sources,
              COALESCE((SELECT s.outcome FROM agent_steps s
                        WHERE s.conversation_id = m.conversation_id
                          AND s.outcome IS NOT NULL
                        ORDER BY s.created_at DESC LIMIT 1), 'respond') AS outcome
       FROM messages m
       WHERE m.conversation_id = $1 AND m.role = 'agent'
       ORDER BY m.created_at DESC LIMIT 1`,
      [conversationId],
    );
    const previousRow = previous.rows[0];
    const outcome = previousRow?.outcome ?? "respond";

    const headers: Record<string, string> = {};
    if (isNewConversation) headers["Set-Cookie"] = buildSetCookie(conversationId);

    if (outcome === "escalate") {
      const escalation = await pool.query<{
        id: string;
        reason: string;
        summary: string;
        draft: string | null;
      }>(
        `SELECT id, reason, summary, draft FROM escalations
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      );
      const row = escalation.rows[0];
      return Response.json(
        {
          conversation_id: conversationId,
          message_id: previousRow?.id ?? existingMessage.id,
          outcome: "escalate",
          answer: null,
          escalation: row
            ? {
                id: row.id,
                reason: row.reason,
                summary: row.summary,
                draft: row.draft,
              }
            : null,
          trace: { steps: 0, tokens: 0, cost_rub: 0 },
        },
        { headers },
      );
    }

    if (shadowMode) {
      // В режиме тени ответ агента не отправлялся и в переписку не попал:
      // повторный запрос того же `client_message_id` возвращает тот же
      // технический результат — эскалацию с черновиком из очереди.
      const escalation = await pool.query<{
        id: string;
        reason: string;
        summary: string;
        draft: string | null;
      }>(
        `SELECT id, reason, summary, draft FROM escalations
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      );
      const row = escalation.rows[0];
      return Response.json(
        {
          conversation_id: conversationId,
          message_id: existingMessage.id,
          outcome: "escalate",
          answer: null,
          escalation: row
            ? {
                id: row.id,
                reason: row.reason,
                summary: row.summary,
                draft: row.draft,
              }
            : null,
          trace: { steps: 0, tokens: 0, cost_rub: 0 },
        },
        { headers },
      );
    }

    return Response.json(
      {
        conversation_id: conversationId,
        message_id: previousRow?.id ?? existingMessage.id,
        outcome: "respond",
        answer: {
          text: previousRow?.text_masked ?? "",
          sources: (previousRow?.sources as unknown[]) ?? [],
        },
        escalation: null,
        trace: { steps: 0, tokens: 0, cost_rub: 0 },
      },
      { headers },
    );
  }

  // Маскирование до вызова модели: в модель уходят только метки.
  const maskScope = await loadMaskScope(pool, tenantId, conversationId);
  const masked = maskPersonalData(body.message.text, { mapping: maskScope.mapping });

  const claimed = await claimConversation(pool, tenantId, conversationId);
  if (!claimed) {
    return errorResponse(
      403,
      "forbidden",
      "Диалог принадлежит другому арендатору",
      requestId,
    );
  }

  // Соответствия меток сохраняются в таблице соответствий диалога: без них
  // исходные значения меток негде взять, и адрес клиента не восстановить.
  // В MAX это делает воркер через порт маскирования; веб-чат обязан сохранить
  // соответствия сам, иначе обещание в веб-канале невозможно — адрес
  // обязателен, а восстановить его не из чего.
  if (masked.maskedFieldsCount > 0) {
    await saveMaskScope(pool, conversationId, masked.mapping);
  }

  await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources)
     VALUES ($1, $2, $3, 'client', $4, $5, '[]'::jsonb)
     ON CONFLICT (tenant_id, client_message_id) DO NOTHING`,
    [tenantId, conversationId, body.message.client_message_id, masked.maskedText, body.message.text],
  );

  const outcome = await runAgent({
    conversationId,
    messageId: body.message.client_message_id,
    channel: "web",
    externalChatId: null,
    text: masked.maskedText,
    maskedFieldsCount: masked.maskedFieldsCount,
    tenantId,
  });

  const headers: Record<string, string> = {};
  if (isNewConversation) headers["Set-Cookie"] = buildSetCookie(conversationId);

  // Ответ, не прошедший проверку, клиенту не отправляется: 422, а не 200
  // с эскалацией — контракт §2 относит непройденную проверку к 422.
  if (outcome.outcome === "escalate" && outcome.escalation.reason === "validation_failed") {
    await recordManagerQueue(pool, {
      tenantId,
      conversationId,
      channel: "web",
      reason: "validation_failed",
      summary: outcome.escalation.summary,
      result: outcome.escalation.draft ?? outcome.escalation.summary,
      draft: outcome.escalation.draft,
      sources: [],
      traceRef: conversationId,
    });
    return errorResponse(
      422,
      "approval_required",
      "Ответ не прошёл проверку и не отправлен клиенту",
      requestId,
    );
  }

  // Ответ, не прошедший проверку на сырые ПД, клиенту не отправляется.
  if (outcome.outcome === "respond") {
    const restored = restoreMaskedData(outcome.answer.text, masked.mapping);
    const restoredSources = outcome.answer.sources;

    // Проверяется именно восстановленный текст: модель вернула метки, но
    // после восстановления в ответе не должно оказаться сырых данных.
    // Значения, восстановленные по таблице соответствий, утечкой не
    // считаются: клиент законно получает свои же данные обратно.
    //
    // Проверяются только персональные данные: источник для ответа без
    // фактов (приветствие, уточняющий вопрос) не требуется, а факты
    // подтверждены источниками ещё в ядре.
    const outgoing = validateOutgoingText(
      restored,
      Object.values(masked.mapping),
      restoredSources.map((source) => source.text),
    );
    if (!outgoing.valid) {
      await recordManagerQueue(pool, {
        tenantId,
        conversationId,
        channel: "web",
        reason: "validation_failed",
        summary: "Ответ не прошёл проверку на персональные данные — передаём менеджеру.",
        result: "Ответ не прошёл проверку на персональные данные — передаём менеджеру.",
        draft: null,
        sources: [],
        traceRef: conversationId,
      });
      return errorResponse(
        422,
        "approval_required",
        "Ответ не прошёл проверку и не отправлен клиенту",
        requestId,
      );
    }

    const tokens = outcome.steps.reduce((sum, step) => sum + step.tokensIn + step.tokensOut, 0);
    const cost = outcome.steps.reduce((sum, step) => sum + step.costRub, 0);

    if (shadowMode) {
      // Режим тени: ответ клиенту не отправляется и в переписку не попадает.
      // Проверенный ответ сохраняется в очереди менеджера, чтобы решение
      // о sends принял человек. Текст в очередь идёт замаскированным: сырые
      // персональные данные в очередь не попадают.
      const queueId = await recordShadowDraft(pool, {
        tenantId,
        conversationId,
        channel: "web",
        summary: "Ответ подготовлен и передан менеджеру.",
        result: outcome.answer.text,
        sources: restoredSources.map((source) => ({
          kind: source.kind,
          id: source.id,
          title: source.title,
          location: source.location,
        })),
        traceRef: conversationId,
      });

      return Response.json(
        {
          conversation_id: conversationId,
          message_id: body.message.client_message_id,
          outcome: "escalate",
          answer: null,
          escalation: {
            id: queueId,
            reason: SHADOW_REASON,
            summary: "Ответ подготовлен и передан менеджеру.",
            draft: outcome.answer.text,
          },
          trace: { steps: outcome.steps.length, tokens, cost_rub: cost },
        },
        { headers },
      );
    }

    const agentMessage = await pool.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources)
       VALUES ($1, $2, $3, 'agent', $4, $5, $6::jsonb)
       RETURNING id`,
      [
        tenantId,
        conversationId,
        randomUUID(),
        outcome.answer.text,
        restored,
        JSON.stringify(
          restoredSources.map((source) => ({
            kind: source.kind,
            id: source.id,
            title: source.title,
            location: source.location,
          })),
        ),
      ],
    );

    return Response.json(
      {
        conversation_id: conversationId,
        message_id: agentMessage.rows[0]?.id ?? body.message.client_message_id,
        outcome: "respond",
        answer: {
          text: restored,
          sources: restoredSources.map((source) => ({
            kind: source.kind,
            id: source.id,
            title: source.title,
            location: source.location,
          })),
        },
        escalation: null,
        trace: { steps: outcome.steps.length, tokens, cost_rub: cost },
      },
      { headers },
    );
  }

  // Обычная эскалация остаётся эскалацией: наличие черновика в очереди не
  // превращает её в разрешение отправить ответ клиенту. Причина исходной
  // эскалации не переписывается — менеджер должен видеть настоящую причину.
  //
  // В режиме `off` очередь менеджера не создаётся: вопрос уточняется у
  // клиента, а не перекладывается менеджеру (ADR-0014). Режим тени запись
  // создаёт всегда: результат, который не отправлен клиенту, должен быть
  // виден менеджеру.
  const escalationResult = outcome.escalation.draft ?? outcome.escalation.summary;
  const escalationId =
    shadowMode || createsManagerQueue()
      ? await recordManagerQueue(pool, {
          tenantId,
          conversationId,
          channel: "web",
          reason: outcome.escalation.reason,
          summary: outcome.escalation.summary,
          result: escalationResult,
          draft: outcome.escalation.draft,
          sources: [],
          traceRef: conversationId,
          // Причина исходной эскалации не переписывается, но признак тени
          // ставится: менеджер должен видеть, что запись пришла из режима тени,
          // а не из обычной эскалации.
          isShadow: shadowMode,
        })
      : null;

  const tokens = outcome.steps.reduce((sum, step) => sum + step.tokensIn + step.tokensOut, 0);
  const cost = outcome.steps.reduce((sum, step) => sum + step.costRub, 0);

  if (shadowMode) {
    // В режиме тени клиенту не отправляется ничего, включая уведомление об
    // эскалации: ответ в переписку не попадает.
    return Response.json(
      {
        conversation_id: conversationId,
        message_id: body.message.client_message_id,
        outcome: "escalate",
        answer: null,
        escalation: {
          id: escalationId ?? outcome.escalation.id,
          reason: outcome.escalation.reason,
          summary: outcome.escalation.summary,
          draft: outcome.escalation.draft,
        },
        trace: { steps: outcome.steps.length, tokens, cost_rub: cost },
      },
      { headers },
    );
  }

  const agentMessage = await pool.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources)
     VALUES ($1, $2, $3, 'agent', $4, $4, '[]'::jsonb)
     RETURNING id`,
    [
      tenantId,
      conversationId,
      randomUUID(),
      outcome.escalation.draft ?? outcome.escalation.summary,
    ],
  );

  return Response.json(
    {
      conversation_id: conversationId,
      message_id: agentMessage.rows[0]?.id ?? body.message.client_message_id,
      outcome: "escalate",
      answer: null,
      escalation: {
        id: escalationId ?? outcome.escalation.id,
        reason: outcome.escalation.reason,
        summary: outcome.escalation.summary,
        draft: outcome.escalation.draft,
      },
      trace: { steps: outcome.steps.length, tokens, cost_rub: cost },
    },
    { headers },
  );
}

/** Таблица соответствий меток диалога: хранится только на сервере. */
async function loadMaskScope(
  pool: Pool,
  tenantId: string,
  conversationId: string,
): Promise<{ mapping: Record<string, string> }> {
  const result = await pool.query<{ text_masked: string }>(
    "SELECT text_masked FROM messages WHERE tenant_id = $1 AND conversation_id = $2",
    [tenantId, conversationId],
  );
  const mapping: Record<string, string> = {};
  for (const row of result.rows) {
    for (const match of row.text_masked.matchAll(/⟦([A-Z]+_\d+)⟧/g)) {
      const label = `⟦${match[1]}⟧`;
      if (!(label in mapping)) mapping[label] = label;
    }
  }
  return { mapping };
}

/**
 * Сохраняет соответствия меток диалога.
 *
 * Исходные значения меток лежат только здесь: в таблицу соответствий
 * диалога, отдельно от текстов сообщений. В модель и трассу они не
 * попадают.
 */
async function saveMaskScope(
  pool: Pool,
  conversationId: string,
  mapping: Record<string, string>,
): Promise<void> {
  for (const [label, value] of Object.entries(mapping)) {
    // Метка без значения — это метка из маскированного текста, исходного
    // значения за ней нет: такие метки нечего сохранять.
    if (value === label) continue;
    await pool.query(
      `INSERT INTO conversation_mask (conversation_id, label, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, label) DO NOTHING`,
      [conversationId, label, value],
    );
  }
}

/**
 * Создание диалога, если его ещё нет.
 *
 * Идентификатор диалога приходит из тела запроса, поэтому перед
 * использованием проверяется принадлежность арендатору: чужой диалог
 * использовать нельзя (docs/data-model.md §5, R15). Возвращается `false`,
 * если диалог принадлежит другому арендатору.
 */
async function claimConversation(
  pool: Pool,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const existing = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM conversations WHERE id = $1",
    [conversationId],
  );
  const found = existing.rows[0];
  if (found) return found.tenant_id === tenantId;

  await pool.query(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'web', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, tenantId],
  );
  return true;
}
