import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ChatRequestSchema } from "@/contracts/chat";
import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { maskPersonalData, restoreMaskedData } from "@/core/mask";
import { createMaskMappingStore } from "@/core/mask-store";
import { createsManagerQueue } from "@/core/escalation-mode";
import { withDialogLock } from "@/core/dialog-lock";
import { runAgentInTurn, type AgentOutcome } from "@/core/run-turn";
import { buildSetCookie, readConversationId } from "@/core/session";
import {
  isShadowMode,
  recordManagerQueue,
  recordShadowDraft,
  SHADOW_REASON,
} from "@/core/shadow-mode";
import {
  isOnlyPersonalDataViolation,
  redactPersonalData,
  validateOutgoingText,
} from "@/core/validate";


/**
 * POST /v1/chat — веб-чат (docs/api-contract.md §4).
 *
 * Порядок: cookie → сверка conversation_id → идемпотентность → маскирование →
 * ядро → восстановление меток → запись хода в базу → ответ по контракту.
 *
 * Диалог определяется подписанной cookie: клиент не может задать или
 * подменить `conversation_id` в теле запроса (docs/api-contract.md §4). Без
 * подписанной cookie клиент получает новый диалог, а значение из тела
 * используется только для сверки повтора.
 */

/** Текст отказа по проверке ответа. */
const APPROVAL_REQUIRED_MESSAGE =
  "Ответ не прошёл проверку и не отправлен клиенту";

/**
 * Фраза клиенту при эскалации.
 *
 * Одна фраза без причин и подробностей: клиенту не нужны ни проценты
 * полномочий агента, ни внутренние правила, ни формулировка причины.
 * Настоящая причина остаётся в очереди менеджера и в трассе — там, где она
 * и нужна (решение владельца от 27.11.2026).
 */
const ESCALATION_NOTICE =
  "Я передал ваш вопрос менеджеру, он ответит вам в ближайшее время.";

/** Причина сбоя хода, не прошедшего ядро. */
const INTERNAL_ERROR_REASON = "internal_error";

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
 * Ключ идемпотентности действует в рамках диалога
 * (docs/api-contract.md §4), а уникальный индекс `messages (tenant_id,
 * client_message_id)` в схеме общий на весь арендатор. Поэтому в колонке
 * лежит не идентификатор сообщения клиента, а выведенный из тройки ключ
 * хода: один и тот же `client_message_id` в двух диалогах даёт два разных
 * ключа, и второе сообщение не теряется молча.
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
 * Ключ записи ответа хода.
 *
 * Ответ агента — отдельная запись переписки со своим `client_message_id`,
 * чтобы не совпадать с ключом сообщения клиента. Связь ответа с исходным
 * сообщением хранится в колонке `reply_to_client_message_id`.
 */
function replyKey(tenantId: string, turn: string): string {
  return uuidFromDigest(
    createHash("sha256").update(`reply:${tenantId}:${turn}`).digest(),
  );
}

/** SHA-256 в формате UUID версии 5. */
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
 * Описание результата хода, не отправленного клиенту.
 *
 * Связи «ход → эскалация» в схеме нет, а результат хода должен
 * восстанавливаться при повторе. Описание хранится в записи сообщения хода:
 * поле `sources` записи несёт идентификатор, причину, резюме и черновик.
 */
type TurnDescriptor = {
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
  escalation: TurnDescriptor | null;
  /** Ответ не прошёл проверку и клиенту не отправлялся: повтор даёт отказ. */
  rejected: boolean;
};

/**
 * Запись хода в переписку диалога.
 *
 * Сообщение клиента и результат хода пишутся одной транзакцией: сбой хода
 * не оставляет диалог в полусостоянии (сообщение без ответа).
 *
 * Исходный текст клиента в таблицу не попадает: `text_original` остаётся
 * пустым, исходные значения лежат только в таблице соответствий меток.
 *
 * Ответ агента связан с исходным сообщением клиента колонкой
 * `reply_to_client_message_id`: повтор того же `client_message_id`
 * возвращает ответ именно этого сообщения, а не последний ответ диалога
 * (находка B1).
 */
async function writeTurn(
  turn: {
    tenantId: string;
    conversationId: string;
    /** Ключ хода: значение колонки `client_message_id` у сообщения клиента. */
    turnKey: string;
    clientTextMasked: string;
    reply: {
      /** Ключ записи ответа: значение колонки `client_message_id` у ответа. */
      messageId: string;
      role: "agent" | "system";
      textMasked: string;
      sources: unknown[];
    };
  },
): Promise<string> {
  // Запись идёт под блокировкой диалога (`src/core/dialog-lock.ts`): блокировка
  // общая для веб-чата и воркера MAX, а два параллельных хода одного диалога
  // не должны повредить переписку друг друга. Обе записи хода — в одной
  // транзакции, поэтому сбой не оставляет диалог в полусостоянии.
  return withDialogLock(turn.conversationId, async (client) => {
    await client.query(
      `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources, reply_to_client_message_id)
       VALUES ($1, $2, $3, 'client', $4, NULL, '[]'::jsonb, NULL)
       ON CONFLICT (tenant_id, client_message_id) DO NOTHING`,
      [
        turn.tenantId,
        turn.conversationId,
        turn.turnKey,
        turn.clientTextMasked,
      ],
    );
    const reply = await client.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, sources, reply_to_client_message_id)
       VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7)
       ON CONFLICT (tenant_id, client_message_id) DO NOTHING
       RETURNING id`,
      [
        turn.tenantId,
        turn.conversationId,
        turn.reply.messageId,
        turn.reply.role,
        turn.reply.textMasked,
        JSON.stringify(turn.reply.sources),
        turn.turnKey,
      ],
    );
    const stored = reply.rows[0];
    if (stored) return stored.id;

    // Ответ хода уже записан: возвращается его идентификатор, чтобы
    // повтор вернул тот же `message_id`.
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM messages WHERE tenant_id = $1 AND client_message_id = $2",
      [turn.tenantId, turn.reply.messageId],
    );
    return existing.rows[0]?.id ?? turn.reply.messageId;
  });
}

/**
 * Занятие диалога арендатором.
 *
 * Проверка владельца и вставка атомарны: вставка возвращает владельца, а при
 * конфликте по идентификатору владелец сверяется отдельно. Без этого
 * проверка и действие были бы разными шагами, и чужой диалог можно было бы
 * занять (docs/data-model.md §5, R15).
 */
async function claimConversation(
  pool: Pool,
  tenantId: string,
  conversationId: string,
): Promise<{ created: boolean; owned: boolean }> {
  const inserted = await pool.query<{ tenant_id: string }>(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'web', 'open')
     ON CONFLICT (id) DO NOTHING
     RETURNING tenant_id`,
    [conversationId, tenantId],
  );
  const row = inserted.rows[0];
  if (row) return { created: true, owned: row.tenant_id === tenantId };

  const existing = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM conversations WHERE id = $1",
    [conversationId],
  );
  const found = existing.rows[0];
  if (!found) return { created: false, owned: false };
  return { created: false, owned: found.tenant_id === tenantId };
}

/**
 * Диалог нового клиента.
 *
 * Без подписанной cookie клиент не может продолжить существующий диалог:
 * идентификатор из тела запроса служит только для сверки. Если такой
 * идентификатор ещё не занят, он становится идентификатором нового
 * диалога; если занят (чужой или прежний), создаётся новый диалог с новым
 * идентификатором.
 */
async function claimNewConversation(
  pool: Pool,
  tenantId: string,
  requestedId: string,
): Promise<string> {
  const taken = await pool.query<{ id: string }>(
    "SELECT id FROM conversations WHERE id = $1",
    [requestedId],
  );
  if (!taken.rows[0]) {
    const claim = await claimConversation(pool, tenantId, requestedId);
    if (claim.created) return requestedId;
  }

  // Идентификатор занят: диалог клиента без cookie всегда новый.
  const fresh = randomUUID();
  await claimConversation(pool, tenantId, fresh);
  return fresh;
}

/**
 * Повтор хода: тот же `client_message_id` в том же диалоге.
 *
 * Ключ идемпотентности — (арендатор, диалог, `client_message_id`): тот же
 * идентификатор в чужом диалоге не подхватывает ответ этого диалога.
 *
 * Ответ хода находится по связи `reply_to_client_message_id`, а не по
 * времени записи: повтор возвращает ответ именно того сообщения, которое
 * клиент повторил (находка B1).
 */
async function findTurn(
  pool: Pool,
  tenantId: string,
  conversationId: string,
  clientMessageId: string,
  restore: (text: string) => Promise<string>,
): Promise<TurnResult | null> {
  const turn = turnKey(tenantId, conversationId, clientMessageId);

  const clientMessage = await pool.query<{ id: string }>(
    `SELECT id FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
        AND client_message_id = $3 AND role = 'client'`,
    [tenantId, conversationId, turn],
  );
  if (!clientMessage.rows[0]) return null;

  const reply = await pool.query<{
    id: string;
    role: string;
    text_masked: string;
    sources: unknown;
  }>(
    `SELECT id, role, text_masked, sources FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
        AND reply_to_client_message_id = $3 AND role IN ('agent', 'system')`,
    [tenantId, conversationId, turn],
  );
  const replyRow = reply.rows[0];
  if (!replyRow) return null;

  const sources = Array.isArray(replyRow.sources) ? replyRow.sources : [];
  const descriptor = sources[0] as Partial<TurnDescriptor> | undefined;

  if (descriptor?.kind === "escalation") {
    const escalation: TurnDescriptor = {
      kind: "escalation",
      id: descriptor.id ?? replyRow.id,
      reason: descriptor.reason ?? "no_confirmed_source",
      summary: descriptor.summary ?? "",
      draft: descriptor.draft ?? null,
    };
    return {
      outcome: "escalate",
      messageId: replyRow.id,
      answer: null,
      escalation,
      rejected: escalation.reason === "validation_failed",
    };
  }

  return {
    outcome: "respond",
    messageId: replyRow.id,
    answer: { text: await restore(replyRow.text_masked), sources },
    escalation: null,
    rejected: false,
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
    // Идентификатор диалога cookie возвращается в деталях: cookie помечена
    // `HttpOnly`, и клиент без доступа к ней иначе не сможет продолжить
    // диалог.
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

  // Восстановление меток идёт по таблице соответствий диалога: она общая
  // для всех каналов и накапливает значения ходов диалога.
  const restore = async (
    text: string,
    conversationId: string,
  ): Promise<string> => {
    const mapping = await maskStore.load(conversationId);
    return restoreMaskedData(text, mapping);
  };

  // Диалог, в котором ищется ход.
  //
  // С подписанной cookie это диалог cookie: тело только сверялось с ней
  // выше. Без подписанной cookie значение из тела определяет лишь
  // кандидата: ход с таким ключом ищется в этом диалоге, а новый ход
  // без найденного повтора получает новый диалог.
  const candidateId = cookieConversation?.id ?? body.conversation_id;

  if (cookieConversation) {
    const claim = await claimConversation(pool, tenantId, candidateId);
    if (!claim.owned) {
      return errorResponse(
        403,
        "forbidden",
        "Диалог принадлежит другому арендатору",
        requestId,
      );
    }
  }

  // Продолжение диалога без подписанной cookie невозможно: cookie —
  // единственное подтверждение принадлежности диалога клиенту. Если клиент
  // прислал `conversation_id` уже существующего диалога, но cookie нет
  // (потеряна, истекла, подделана), сервер не продолжает диалог и не создаёт
  // новый: клиенту предлагается войти заново.
  //
  // Проверка стоит до поиска повтора: повтор хода без cookie — это тоже
  // чтение чужого диалога по одному лишь знанию идентификатора.
  if (!cookieConversation) {
    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2",
      [body.conversation_id, tenantId],
    );
    if (existing.rows[0]) {
      return errorResponse(
        409,
        "conversation_cookie_required",
        "Продолжение диалога требует входа: обновите страницу и введите код доступа",
        requestId,
      );
    }
  }

  // Идемпотентность: повтор client_message_id не создаёт второе обращение.
  // Повтор распознаётся по ключу хода (арендатор, диалог, сообщение) и
  // возвращает ответ именно этого сообщения.
  const repeated = await findTurn(
    pool,
    tenantId,
    candidateId,
    body.message.client_message_id,
    (text) => restore(text, candidateId),
  );
  if (repeated) {
    if (repeated.rejected) {
      return errorResponse(
        422,
        "approval_required",
        APPROVAL_REQUIRED_MESSAGE,
        requestId,
      );
    }
    if (repeated.escalation?.reason === INTERNAL_ERROR_REASON) {
      return errorResponse(
        500,
        "internal_error",
        "Ход не обработан: сбой агентного цикла",
        requestId,
      );
    }
    // Cookie не выдаётся: подписанная cookie — единственное подтверждение
    // принадлежности диалога, и её нельзя выдать по одному лишь знанию
    // идентификатора из тела запроса.
    return Response.json(
      {
        conversation_id: candidateId,
        message_id: repeated.messageId,
        outcome: repeated.outcome,
        answer: repeated.answer,
        escalation: repeated.escalation,
        trace: { steps: 0, tokens: 0, cost_rub: 0 },
      },
      { headers: {} },
    );
  }

  // Диалог, в котором выполняется ход.
  //
  // Без подписанной cookie существующий диалог не продолжается: ход с новым
  // ключом получает новый диалог, и идентификатор из тела может стать его
  // идентификатором только если он ещё свободен.
  const conversationId = cookieConversation
    ? candidateId
    : await claimNewConversation(pool, tenantId, candidateId);

  const headers: Record<string, string> = {};
  if (!cookieConversation) {
    headers["Set-Cookie"] = buildSetCookie(conversationId);
  }

  // Маскирование до вызова модели: в модель уходят только метки. Таблица
  // соответствий диалога читается до маскирования, поэтому метки одного
  // диалога накапливаются и восстанавливаются во всех ходах.
  const known = await maskStore.load(conversationId);
  const masked = maskPersonalData(body.message.text, { mapping: known });
  if (masked.maskedFieldsCount > 0) {
    await maskStore.save(conversationId, masked.mapping);
  }

  const turn = turnKey(
    tenantId,
    conversationId,
    body.message.client_message_id,
  );
  const replyMessageId = replyKey(tenantId, turn);

  let outcome: AgentOutcome;
  try {
    // Ядро запускается в контексте хода (`src/core/run-turn.ts`): ключ шага
    // трассы выводится из идентификатора хода, поэтому повтор того же хода
    // не создаёт второй шаг.
    outcome = await runAgentInTurn({
      conversationId,
      messageId: turn,
      channel: "web",
      externalChatId: null,
      text: masked.maskedText,
      maskedFieldsCount: masked.maskedFieldsCount,
      tenantId,
    });
  } catch {
    // Сбой ядра не оставляет диалог в полусостоянии: ход фиксируется как
    // отказ, а не как сообщение без ответа.
    const summary = "Ход не обработан: сбой агентного цикла.";
    await writeTurn({
      tenantId,
      conversationId,
      turnKey: turn,
      clientTextMasked: masked.maskedText,
      reply: {
        messageId: replyMessageId,
        role: "system",
        textMasked: "",
        sources: [
          {
            kind: "escalation",
            id: randomUUID(),
            reason: INTERNAL_ERROR_REASON,
            summary,
            draft: null,
          } satisfies TurnDescriptor,
        ],
      },
    });
    return errorResponse(
      500,
      "internal_error",
      "Ход не обработан: сбой агентного цикла",
      requestId,
    );
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
    await writeTurn({
      tenantId,
      conversationId,
      turnKey: turn,
      clientTextMasked: masked.maskedText,
      reply: {
        messageId: replyMessageId,
        role: "system",
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
          } satisfies TurnDescriptor,
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
    let outgoing = validateOutgoingText(
      restored,
      Object.values(masked.mapping),
      restoredSources.map((source) => source.text),
    );

    // Ответ с единственным нарушением по персональным данным правится
    // детерминированно: значения вырезаются, а на их место встаёт «контакт
    // скрыт». Модель иногда называет контакт, которого нет в источниках, —
    // ответ по существу верный, и отправлять клиенту «не обработано» вместо
    // него незачем. Если после правки остаются другие нарушения (сумма,
    // цитата), ответ уходит менеджеру.
    let outgoingText = restored;
    if (!outgoing.valid && isOnlyPersonalDataViolation(outgoing)) {
      const edited = redactPersonalData(restored);
      if (edited.redacted) {
        const rechecked = validateOutgoingText(
          edited.text,
          Object.values(masked.mapping),
          restoredSources.map((source) => source.text),
        );
        if (rechecked.valid) {
          outgoing = rechecked;
          outgoingText = edited.text;
        }
      }
    }

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
      await writeTurn({
        tenantId,
        conversationId,
        turnKey: turn,
        clientTextMasked: masked.maskedText,
        reply: {
          messageId: replyMessageId,
          role: "system",
          textMasked: "",
          sources: [
            {
              kind: "escalation",
              id: escalationId ?? randomUUID(),
              reason: "validation_failed",
              summary,
              draft: null,
            } satisfies TurnDescriptor,
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

      const messageId = await writeTurn({
        tenantId,
        conversationId,
        turnKey: turn,
        clientTextMasked: masked.maskedText,
        reply: {
          messageId: replyMessageId,
          role: "system",
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
            } satisfies TurnDescriptor,
          ],
        },
      });

      return Response.json(
        {
          conversation_id: conversationId,
          message_id: messageId,
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

    const messageId = await writeTurn({
      tenantId,
      conversationId,
      turnKey: turn,
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
        message_id: messageId,
        outcome: "respond",
        answer: {
          text: outgoingText,
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

  // Клиенту при эскалации уходит одна фраза без причин и подробностей:
  // «передаём менеджеру» — внутренняя кухня, а «скидка 10% выше полномочий
  // (до 5%)» — деталь, клиенту не нужная. Настоящая причина остаётся в
  // очереди менеджера и в трассе (решение владельца от 27.11.2026).
  const clientEscalationText = ESCALATION_NOTICE;

  const messageId = await writeTurn({
    tenantId,
    conversationId,
    turnKey: turn,
    clientTextMasked: masked.maskedText,
    reply: {
      messageId: replyMessageId,
      role: "system",
      textMasked: shadowMode ? "" : clientEscalationText,
      sources: [
        {
          kind: "escalation",
          id: escalationId ?? outcome.escalation.id,
          reason: outcome.escalation.reason,
          summary: outcome.escalation.summary,
          draft: outcome.escalation.draft,
        } satisfies TurnDescriptor,
      ],
    },
  });

  return Response.json(
    {
      conversation_id: conversationId,
      message_id: messageId,
      outcome: "escalate",
      answer: null,
      escalation: {
        id: escalationId ?? outcome.escalation.id,
        reason: outcome.escalation.reason,
        // Клиентскому интерфейсу показывается короткая фраза; полная причина
        // остаётся в очереди менеджера и в трассе.
        summary: clientEscalationText,
        draft: outcome.escalation.draft,
      },
      trace: { steps: outcome.steps.length, tokens, cost_rub: cost },
    },
    { headers },
  );
}
