import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ChatRequestSchema } from "@/contracts/chat";
import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { maskPersonalData, restoreMaskedData } from "@/core/mask";
import { createMaskMappingStore } from "@/core/mask-store";
import { createsManagerQueue } from "@/core/escalation-mode";
import { runAgent, type AgentOutcome } from "@/core/run";
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
 * Порядок: cookie → сверка conversation_id → идемпотентность → маскирование →
 * ядро → восстановление меток → запись хода в базу → ответ по контракту.
 *
 * Идентификация по IP не используется: диалог определяется только
 * подписанной cookie. Значение из тела запроса диалог не определяет — без
 * подписанной cookie клиент получает новый диалог, а значение из тела
 * используется только для сверки повтора.
 */

/** Текст ошибки при отказе по проверке ответа. */
const APPROVAL_REQUIRED_MESSAGE = "Ответ не прошёл проверку и не отправлен клиенту";

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: { code, message, details, request_id: requestId } },
    { status },
  );
}

/**
 * Ключ хода: идентификатор сообщения по тройке
 * (арендатор, диалог, `client_message_id`).
 *
 * Уникальный индекс `messages (tenant_id, client_message_id)` в схеме общий
 * на весь арендатор, а идемпотентность должна действовать в рамках диалога
 * (docs/api-contract.md §4). Поэтому в колонке хранится не идентификатор
 * сообщения клиента, а выведенный из тройки ключ хода: один и тот же
 * `client_message_id` в двух диалогах даёт два разных ключа, и второе
 * сообщение не теряется молча.
 *
 * Значение — UUID версии 5 по SHA-256: колонка объявлена как `uuid`.
 */
function turnKey(
  tenantId: string,
  conversationId: string,
  clientMessageId: string,
): string {
  return uuidFromDigest(
    createHash("sha256")
      .update(`turn:${tenantId}:${conversationId}:${clientMessageId}`)
      .digest(),
  );
}

/**
 * Ключ ответа хода.
 *
 * Ответ агента связан с исходным сообщением: повтор того же
 * `client_message_id` возвращает ответ именно этого сообщения, а не
 * последний ответ диалога.
 */
function replyKey(
  tenantId: string,
  conversationId: string,
  clientMessageId: string,
): string {
  return uuidFromDigest(
    createHash("sha256")
      .update(`reply:${tenantId}:${conversationId}:${clientMessageId}`)
      .digest(),
  );
}

/** Случайные 16 байт в формате UUID версии 5. */
function uuidFromDigest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Описание эскалации хода.
 *
 * Связи «ход → эскалация» в схеме нет, а ответ хода должен восстанавливаться
 * при повторе. Описание хранится в записи сообщения хода: поле `sources`
 * записи-эскалации несёт идентификатор, причину, резюме и черновик.
 */
type EscalationDescriptor = {
  kind: "escalation";
  id: string;
  reason: string;
  summary: string;
  draft: string | null;
};

/** Результат хода, восстановленный из переписки. */
type TurnResult = {
  outcome: "respond" | "escalate";
  messageId: string;
  answer: { text: string; sources: unknown[] } | null;
  escalation: EscalationDescriptor | null;
  /** Ответ не прошёл проверку и клиенту не отправлялся: повтор даёт тот же отказ. */
  rejected: boolean;
};

/**
 * Запись хода в переписку диалога.
 *
 * Сообщение клиента и ответ агента пишутся одной транзакцией: сбой хода не
 * оставляет диалог в полусостоянии (сообщение без ответа).
 *
 * Исходный текст клиента в таблицу не попадает: `text_original` остаётся
 * пустым, исходные значения лежат только в таблице соответствий меток.
 */
async function writeTurn(
  pool: Pool,
  turn: {
    tenantId: string;
    conversationId: string;
    clientMessageId: string;
    clientTextMasked: string;
    reply: {
      messageId: string;
      role: "agent" | "manager";
      textMasked: string;
      sources: unknown[];
    } | null;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources)
         VALUES ($1, $2, $3, 'client', $4, NULL, '[]'::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          turn.tenantId,
          turn.conversationId,
          turn.clientMessageId,
          turn.clientTextMasked,
        ],
      );
      if (turn.reply) {
        await client.query(
          `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources)
           VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            turn.tenantId,
            turn.conversationId,
            turn.reply.messageId,
            turn.reply.role,
            turn.reply.textMasked,
            JSON.stringify(turn.reply.sources),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Создание диалога, если его ещё нет.
 *
 * Проверка владельца и вставка атомарны: конфликт по идентификатору означает,
 * что диалог уже существует, и его владелец сверяется отдельно. Возвращается
 * `false`, если диалог принадлежит другому арендатору
 * (docs/data-model.md §5, R15).
 */
async function claimConversation(
  pool: Pool,
  tenantId: string,
  conversationId: string,
  clientRef: string,
): Promise<boolean> {
  const inserted = await pool.query<{ tenant_id: string }>(
    `INSERT INTO conversations (id, tenant_id, channel, status, client_ref)
     VALUES ($1, $2, 'web', 'open', $3)
     ON CONFLICT (id) DO NOTHING
     RETURNING tenant_id`,
    [conversationId, tenantId, clientRef],
  );
  const row = inserted.rows[0];
  if (row) return row.tenant_id === tenantId;

  // Конфликт: диалог с таким идентификатором уже есть. Владелец сверяется
  // отдельно — иначе проверка и вставка были бы разными действиями, и чужой
  // диалог можно было бы занять.
  const existing = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM conversations WHERE id = $1",
    [conversationId],
  );
  const found = existing.rows[0];
  if (!found) return false;
  return found.tenant_id === tenantId;
}

/**
 * Повтор хода: тот же `client_message_id` в том же диалоге.
 *
 * Ключ идемпотентности — (арендатор, диалог, `client_message_id`): тот же
 * идентификатор в чужом диалоге не подхватывает ответ этого диалога.
 * Возвращается результат именно этого хода.
 */
async function findTurn(
  pool: Pool,
  tenantId: string,
  conversationIds: string[],
  clientMessageId: string,
  restore: (text: string) => Promise<string>,
): Promise<TurnResult | null> {
  if (conversationIds.length === 0) return null;

  const keys = conversationIds.map((conversationId) =>
    turnKey(tenantId, conversationId, clientMessageId),
  );
  const clientMessage = await pool.query<{
    id: string;
    conversation_id: string;
  }>(
    `SELECT id, conversation_id FROM messages
      WHERE tenant_id = $1 AND role = 'client'
        AND conversation_id = ANY($2::uuid[])
        AND client_message_id = ANY($3::uuid[])
      ORDER BY created_at ASC LIMIT 1`,
    [tenantId, conversationIds, keys],
  );
  const clientRow = clientMessage.rows[0];
  if (!clientRow) return null;

  const conversationId = clientRow.conversation_id;
  const replyMessageId = replyKey(tenantId, conversationId, clientMessageId);
  const reply = await pool.query<{
    id: string;
    role: string;
    text_masked: string;
    sources: unknown;
  }>(
    `SELECT id, role, text_masked, sources FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
        AND client_message_id = $3 AND role IN ('agent', 'manager')`,
    [tenantId, conversationId, replyMessageId],
  );
  const replyRow = reply.rows[0];

  if (!replyRow) return null;

  if (replyRow.role === "agent") {
    const sources = Array.isArray(replyRow.sources) ? replyRow.sources : [];
    return {
      outcome: "respond",
      messageId: replyMessageId,
      answer: { text: await restore(replyRow.text_masked), sources },
      escalation: null,
      rejected: false,
    };
  }

  const descriptor = (
    Array.isArray(replyRow.sources) ? replyRow.sources[0] : undefined
  ) as Partial<EscalationDescriptor> | undefined;
  const escalation: EscalationDescriptor = {
    kind: "escalation",
    id: descriptor?.id ?? replyRow.id,
    reason: descriptor?.reason ?? "no_confirmed_source",
    summary: descriptor?.summary ?? "",
    draft: descriptor?.draft ?? null,
  };
  return {
    outcome: "escalate",
    messageId: replyMessageId,
    answer: null,
    escalation,
    rejected: escalation.reason === "validation_failed",
  };
}

/**
 * Запись в очередь менеджера.
 *
 * Ошибка записи не должна ронять ход: клиент получит ответ, а вопрос
 * менеджеру появится в следующей записи. Поэтому исключение здесь
 * превращается в пустой результат, а не в 500.
 */
async function recordManagerQueueSafely(
  pool: Pool,
  input: {
    tenantId: string;
    conversationId: string;
    reason: string;
    summary: string;
    draft: string | null;
    isShadow?: boolean;
  },
): Promise<string | null> {
  try {
    return await recordManagerQueue(pool, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      channel: "web",
      reason: input.reason,
      summary: input.summary,
      result: input.draft ?? input.summary,
      draft: input.draft,
      sources: [],
      traceRef: input.conversationId,
      isShadow: input.isShadow === true,
    });
  } catch {
    return null;
  }
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
    // Идентификатор ожидаемого диалога возвращается в деталях: клиент без
    // доступа к cookie (HttpOnly) иначе не сможет продолжить диалог.
    return errorResponse(
      403,
      "forbidden",
      "conversation_id не совпадает с подписанной cookie",
      requestId,
      { conversation_id: cookieConversation.id },
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

  const pool = getPool();
  const maskStore = createMaskMappingStore(pool);

  // Режим тени снимается один раз в начале обработки и действует на неё
  // целиком: переключение настройки посередине обработки не должно менять
  // её исход (docs/plans/06-shadow-mode.md, шаг 4).
  const shadowMode = await isShadowMode(pool, tenantId);

  // Идентификатор диалога, который знает клиент: подписанная cookie, а без
  // неё — значение из тела запроса. Он используется только для сверки
  // повтора: подписанной cookie нет, значит диалог не продолжается.
  const clientRef = cookieConversation?.id ?? body.conversation_id;

  // Диалоги, в которых ищется повтор хода. С подписанной cookie это ровно
  // один диалог; без неё — диалоги, созданные клиентом с таким значением.
  const scope = await conversationScope(pool, tenantId, clientRef, cookieConversation !== null);

  // Восстановление меток идёт по таблице соответствий диалога: она общая
  // для всех каналов и накапливает значения ходов диалога.
  const restore = async (text: string): Promise<string> => {
    const mapping = await maskStore.load(clientRef);
    return restoreMaskedData(text, mapping);
  };

  // Идемпотентность: повтор client_message_id не создаёт второе обращение.
  const repeated = await findTurn(
    pool,
    tenantId,
    scope,
    body.message.client_message_id,
    restore,
  );
  if (repeated) {
    const headers: Record<string, string> = {};
    if (cookieConversation === null) {
      headers["Set-Cookie"] = buildSetCookie(scope[0] ?? randomUUID());
    }
    if (repeated.rejected) {
      return errorResponse(
        422,
        "approval_required",
        APPROVAL_REQUIRED_MESSAGE,
        requestId,
      );
    }
    return Response.json(
      {
        conversation_id: scope[0] ?? clientRef,
        message_id: repeated.messageId,
        outcome: repeated.outcome,
        answer: repeated.answer,
        escalation: repeated.escalation,
        trace: { steps: 0, tokens: 0, cost_rub: 0 },
      },
      { headers },
    );
  }

  // Диалог, в котором выполняется ход. С подписанной cookie это диалог
  // cookie. Без неё — новый диалог: значение из тела запроса диалог не
  // определяет и чужой диалог не продолжает.
  const conversationId = cookieConversation?.id ?? randomUUID();

  const claimed = await claimConversation(pool, tenantId, conversationId, clientRef);
  if (!claimed) {
    return errorResponse(
      403,
      "forbidden",
      "Диалог принадлежит другому арендатору",
      requestId,
    );
  }

  // Маскирование до вызова модели: в модель уходят только метки. Таблица
  // соответствий диалога читается до маскирования, поэтому метки одного
  // диалога накапливаются и восстанавливаются во всех ходах.
  const known = await maskStore.load(conversationId);
  const masked = maskPersonalData(body.message.text, { mapping: known });
  if (masked.maskedFieldsCount > 0) {
    await maskStore.save(conversationId, masked.mapping);
  }

  const messageKey = turnKey(
    tenantId,
    conversationId,
    body.message.client_message_id,
  );
  const replyMessageId = replyKey(
    tenantId,
    conversationId,
    body.message.client_message_id,
  );

  let outcome: AgentOutcome;
  try {
    outcome = await runAgent({
      conversationId,
      messageId: messageKey,
      channel: "web",
      externalChatId: null,
      text: masked.maskedText,
      maskedFieldsCount: masked.maskedFieldsCount,
      tenantId,
    });
  } catch {
    // Сбой ядра не оставляет диалог в полусостоянии: сообщение клиента и
    // результат хода пишутся одной транзакцией, а ход с ошибкой
    // фиксируется как отказ, а не как сообщение без ответа.
    const summary = "Ход не обработан: сбой агентного цикла.";
    const escalationId = createsManagerQueue()
      ? await recordManagerQueueSafely(pool, {
          tenantId,
          conversationId,
          reason: "internal_error",
          summary,
          draft: null,
        })
      : null;
    await writeTurn(pool, {
      tenantId,
      conversationId,
      clientMessageId: messageKey,
      clientTextMasked: masked.maskedText,
      reply: {
        messageId: replyMessageId,
        role: "manager",
        textMasked: "",
        sources: [
          {
            kind: "escalation",
            id: escalationId ?? randomUUID(),
            reason: "internal_error",
            summary,
            draft: null,
          } satisfies EscalationDescriptor,
        ],
      },
    });
    return Response.json(
      {
        conversation_id: conversationId,
        message_id: replyMessageId,
        outcome: "escalate",
        answer: null,
        escalation: {
          id: escalationId ?? randomUUID(),
          reason: "internal_error",
          summary,
          draft: null,
        },
        trace: { steps: 0, tokens: 0, cost_rub: 0 },
      },
      { headers: {} },
    );
  }

  const headers: Record<string, string> = {};
  if (cookieConversation === null) {
    headers["Set-Cookie"] = buildSetCookie(conversationId);
  }

  // Ответ, не прошедший проверку, клиенту не отправляется: 422, а не 200
  // с эскалацией — контракт §2 относит непройденную проверку к 422.
  if (outcome.outcome === "escalate" && outcome.escalation.reason === "validation_failed") {
    const escalationId = await recordManagerQueueSafely(pool, {
      tenantId,
      conversationId,
      reason: "validation_failed",
      summary: outcome.escalation.summary,
      draft: outcome.escalation.draft,
    });
    await writeTurn(pool, {
      tenantId,
      conversationId,
      clientMessageId: messageKey,
      clientTextMasked: masked.maskedText,
      reply: {
        messageId: replyMessageId,
        role: "manager",
        // Ответ, отклонённый проверкой, в переписку не попадает: в записи
        // хода остаётся только сам факт отказа.
        textMasked: "",
        sources: [
          {
            kind: "escalation",
            id: escalationId ?? randomUUID(),
            reason: "validation_failed",
            summary: outcome.escalation.summary,
            draft: outcome.escalation.draft,
          } satisfies EscalationDescriptor,
        ],
      },
    });
    return errorResponse(
      422,
      "approval_required",
      APPROVAL_REQUIRED_MESSAGE,
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
      const summary =
        "Ответ не прошёл проверку на персональные данные — передаём менеджеру.";
      const escalationId = await recordManagerQueueSafely(pool, {
        tenantId,
        conversationId,
        reason: "validation_failed",
        summary,
        draft: null,
      });
      await writeTurn(pool, {
        tenantId,
        conversationId,
        clientMessageId: messageKey,
        clientTextMasked: masked.maskedText,
        reply: {
          messageId: replyMessageId,
          role: "manager",
          textMasked: "",
          sources: [
            {
              kind: "escalation",
              id: escalationId ?? randomUUID(),
              reason: "validation_failed",
              summary,
              draft: null,
            } satisfies EscalationDescriptor,
          ],
        },
      });
      return errorResponse(
        422,
        "approval_required",
        APPROVAL_REQUIRED_MESSAGE,
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

      await writeTurn(pool, {
        tenantId,
        conversationId,
        clientMessageId: messageKey,
        clientTextMasked: masked.maskedText,
        reply: {
          messageId: replyMessageId,
          role: "manager",
          // Ответ агента в тени клиенту не отправлялся: в переписку он не
          // попадает, запись хода хранит только сам факт обработки.
          textMasked: "",
          sources: [
            {
              kind: "escalation",
              id: queueId,
              reason: SHADOW_REASON,
              summary: "Ответ подготовлен и передан менеджеру.",
              draft: outcome.answer.text,
            } satisfies EscalationDescriptor,
          ],
        },
      });

      return Response.json(
        {
          conversation_id: conversationId,
          message_id: replyMessageId,
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

    await writeTurn(pool, {
      tenantId,
      conversationId,
      clientMessageId: messageKey,
      clientTextMasked: masked.maskedText,
      reply: {
        messageId: replyMessageId,
        role: "agent",
        // Ответ агента сохраняется замаскированным: исходные значения
        // восстанавливаются по таблице соответствий диалога, а в таблицу
        // сообщений сырые персональные данные не попадают.
        textMasked: outcome.answer.text,
        sources: restoredSources.map((source) => ({
          kind: source.kind,
          id: source.id,
          title: source.title,
          location: source.location,
        })),
      },
    });

    return Response.json(
      {
        conversation_id: conversationId,
        message_id: replyMessageId,
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
      ? await recordManagerQueueSafely(pool, {
          tenantId,
          conversationId,
          reason: outcome.escalation.reason,
          summary: outcome.escalation.summary,
          draft: outcome.escalation.draft,
          isShadow: shadowMode,
        })
      : null;

  const tokens = outcome.steps.reduce((sum, step) => sum + step.tokensIn + step.tokensOut, 0);
  const cost = outcome.steps.reduce((sum, step) => sum + step.costRub, 0);

  if (shadowMode) {
    // В режиме тени клиенту не отправляется ничего, включая уведомление об
    // эскалации: ответ в переписку не попадает.
    await writeTurn(pool, {
      tenantId,
      conversationId,
      clientMessageId: messageKey,
      clientTextMasked: masked.maskedText,
      reply: {
        messageId: replyMessageId,
        role: "manager",
        textMasked: "",
        sources: [
          {
            kind: "escalation",
            id: escalationId ?? outcome.escalation.id,
            reason: outcome.escalation.reason,
            summary: outcome.escalation.summary,
            draft: outcome.escalation.draft,
          } satisfies EscalationDescriptor,
        ],
      },
    });

    return Response.json(
      {
        conversation_id: conversationId,
        message_id: replyMessageId,
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

  await writeTurn(pool, {
    tenantId,
    conversationId,
    clientMessageId: messageKey,
    clientTextMasked: masked.maskedText,
    reply: {
      messageId: replyMessageId,
      role: "manager",
      textMasked: escalationResult,
      sources: [
        {
          kind: "escalation",
          id: escalationId ?? outcome.escalation.id,
          reason: outcome.escalation.reason,
          summary: outcome.escalation.summary,
          draft: outcome.escalation.draft,
        } satisfies EscalationDescriptor,
      ],
    },
  });

  return Response.json(
    {
      conversation_id: conversationId,
      message_id: replyMessageId,
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

/**
 * Диалоги, в которых ищется повтор хода.
 *
 * С подписанной cookie диалог известен точно. Без неё значение из тела
 * запроса используется только для сверки: им отбираются диалоги, созданные
 * клиентом с таким значением, — продолжать их без cookie нельзя.
 */
async function conversationScope(
  pool: Pool,
  tenantId: string,
  clientRef: string,
  signed: boolean,
): Promise<string[]> {
  if (signed) return [clientRef];
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM conversations WHERE tenant_id = $1 AND client_ref = $2",
    [tenantId, clientRef],
  );
  return result.rows.map((row) => row.id);
}
