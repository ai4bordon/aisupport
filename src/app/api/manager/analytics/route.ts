import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { accessHttpStatus, checkManagerAccess } from "@/modules/access";

/**
 * GET /api/manager/analytics — данные раздела кабинера «Аналитика».
 *
 * Маршрут отдаёт четыре измеренные метрики по фактическим трассам агента:
 *
 * 1) стоимость диалога — среднее, минимум и максимум по сумме `cost_rub`
 *    шагов каждого диалога (`agent_steps`);
 * 2) доля автозакрытия — по двум вариантам заказчика (docs/QA_new.md,
 *    вопрос 5): ответ агента без менеджера и КП, подтверждённое менеджером;
 * 3) средний первый ответ — от первого сообщения клиента до первого
 *    ответа агента по переписке (`messages`);
 * 4) пробелы базы знаний — вопросы, по которым подтверждённого источника
 *    не нашлось (`agent_steps` с причиной `no_confirmed_source`).
 *
 * Ни одна доля не задана константой: все величины считаются делением
 * измеренных числителя и знаменателя, поэтому добавление новой записи
 * меняет цифры ровно на эту запись.
 *
 * Кабинет закрыт cookie `support_manager`. Арендатор определяется сервером
 * и не принимается из тела запроса (R15).
 */

/** Ориентир заказчика до первого ответа — две минуты (docs/QA_new.md). */
const FIRST_RESPONSE_TARGET_MS = 120_000;

/** Слаг демонстрационного арендатора: его данные синтетические. */
const DEMO_TENANT_SLUG = "demo-tenant";

/** Строка `agent_steps` в терминах маршрута. */
type StepRow = {
  conversation_id: string;
  node: string;
  outcome: string | null;
  intent: string | null;
};

/** Сумма шагов одного диалога. */
type DialogCostRow = {
  conversation_id: string;
  cost_rub: string;
  tokens_in: string;
  tokens_out: string;
};

/** Времена первых сообщений по диалогу. */
type FirstMessageRow = {
  conversation_id: string;
  first_client: Date | null;
  first_agent: Date | null;
};

/** Пробел в знаниях: вопрос без подтверждённого источника. */
type KnowledgeGap = {
  intent: string;
  node: string;
  count: number;
};

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

/** Округление до четырёх знаков: суммы денег не копятся из-за двоичной дроби. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Намерение диалога по шагу классификации.
 *
 * Шаг, где источник не подтвердился, намерения в себе не несёт: класс
 * обращения пишет шаг `classify`. Без этого пробелы в знаниях попадали бы
 * в общую группу «неизвестно» и теряли самый полезный признак — о чём
 * спрашивали.
 */
async function readDialogIntents(
  tenantId: string,
): Promise<Map<string, string>> {
  const result = await getPool().query<{ conversation_id: string; intent: string | null }>(
    `SELECT DISTINCT ON (conversation_id)
            conversation_id,
            metadata->>'intent' AS intent
       FROM agent_steps
      WHERE tenant_id = $1 AND node = 'classify'
      ORDER BY conversation_id, created_at ASC, id ASC`,
    [tenantId],
  );
  const intents = new Map<string, string>();
  for (const row of result.rows) {
    if (row.intent !== null) intents.set(row.conversation_id, row.intent);
  }
  return intents;
}

/** Итоговый шаг каждого диалога: последний по времени, у него есть результат. */
async function readLastSteps(tenantId: string): Promise<Map<string, StepRow>> {
  const result = await getPool().query<StepRow>(
    `SELECT DISTINCT ON (conversation_id)
            conversation_id,
            node,
            outcome,
            metadata->>'intent' AS intent
       FROM agent_steps
      WHERE tenant_id = $1
      ORDER BY conversation_id, created_at DESC, id DESC`,
    [tenantId],
  );
  const last = new Map<string, StepRow>();
  for (const row of result.rows) last.set(row.conversation_id, row);
  return last;
}

/** Сумма стоимости и токенов по каждому диалогу. */
async function readDialogCosts(
  tenantId: string,
): Promise<Map<string, DialogCostRow>> {
  const result = await getPool().query<DialogCostRow>(
    `SELECT conversation_id,
            COALESCE(SUM(cost_rub), 0)  AS cost_rub,
            COALESCE(SUM(tokens_in), 0)  AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out
       FROM agent_steps
      WHERE tenant_id = $1
      GROUP BY conversation_id`,
    [tenantId],
  );
  const costs = new Map<string, DialogCostRow>();
  for (const row of result.rows) costs.set(row.conversation_id, row);
  return costs;
}

/** Времена первых сообщений клиента и агента по диалогам. */
async function readFirstMessages(
  tenantId: string,
): Promise<Map<string, FirstMessageRow>> {
  const result = await getPool().query<FirstMessageRow>(
    `SELECT conversation_id,
            MIN(created_at) FILTER (WHERE role = 'client') AS first_client,
            MIN(created_at) FILTER (WHERE role = 'agent')  AS first_agent
       FROM messages
      WHERE tenant_id = $1
      GROUP BY conversation_id`,
    [tenantId],
  );
  const first = new Map<string, FirstMessageRow>();
  for (const row of result.rows) first.set(row.conversation_id, row);
  return first;
}

/**
 * Участие менеджера в диалогах — по фактам, которые реально пишет код.
 *
 * Различаются два состояния:
 * - `touched` — менеджер участвовал в диалоге: дело стоит в его очереди
 *   (`escalations`), он закрыл его, ответил в переписке или исполнил
 *   обещание клиенту (`promises` со статусом `done`). Такой диалог агент
 *   закрыть не мог;
 * - `handled` — менеджер дело закрыл: закрыл обращение в очереди, ответил в
 *   переписке или исполнил обещание.
 *
 * Разница нужна для второго варианта автозакрытия: КП, подтверждённое
 * менеджером, — это не «менеджер увидел», а «менеджер подтвердил».
 */
type ManagerParticipation = {
  touched: Set<string>;
  handled: Set<string>;
};

async function readManagerParticipation(tenantId: string): Promise<ManagerParticipation> {
  const touched = new Set<string>();
  const handled = new Set<string>();

  const replies = await getPool().query<{ conversation_id: string }>(
    `SELECT DISTINCT conversation_id
       FROM messages
      WHERE tenant_id = $1 AND role = 'manager'`,
    [tenantId],
  );
  for (const row of replies.rows) {
    touched.add(row.conversation_id);
    handled.add(row.conversation_id);
  }

  const escalations = await getPool().query<{
    conversation_id: string;
    status: string;
  }>(
    `SELECT DISTINCT conversation_id, status
       FROM escalations
      WHERE tenant_id = $1`,
    [tenantId],
  );
  for (const row of escalations.rows) {
    touched.add(row.conversation_id);
    if (row.status === "closed") handled.add(row.conversation_id);
  }

  // Исполненное обещание — работа менеджера, а не агента.
  const promises = await getPool().query<{ conversation_id: string }>(
    `SELECT DISTINCT conversation_id
       FROM promises
      WHERE tenant_id = $1 AND status = 'done'`,
    [tenantId],
  );
  for (const row of promises.rows) {
    touched.add(row.conversation_id);
    handled.add(row.conversation_id);
  }

  return { touched, handled };
}

/**
 * Диалоги, по которым менеджер подтвердил коммерческое предложение.
 *
 * Второй вариант автозакрытия по брифингу заказчика (docs/QA_new.md,
 * вопрос 5) — КП, подтверждённое менеджером одним нажатием. Подтверждение
 * менеджера фиксируется двумя способами, и оба читаются:
 *
 * - `manager_confirmations` — отдельная запись о подтверждении (появляется
 *   вместе со срезом 09 аналитики; таблицы может ещё не быть в базе, тогда
 *   запрос к ней не выполняется вовсе);
 * - `escalations` со статусом `closed` по диалогу, в котором выпущено КП, —
 *   менеджер закрыл дело с выпущенным предложением.
 *
 * Если ни одного подтверждения нет, вариант остаётся нулём: отсутствие
 * записи не превращается в «менеджер подтвердил».
 */
async function readManagerConfirmedQuotes(tenantId: string): Promise<Set<string>> {
  const confirmed = new Set<string>();

  const hasConfirmations = await getPool().query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'manager_confirmations'
     ) AS present`,
  );
  if (hasConfirmations.rows[0]?.present === true) {
    const records = await getPool().query<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id
         FROM manager_confirmations
        WHERE tenant_id = $1 AND kind = 'quote'`,
      [tenantId],
    );
    for (const row of records.rows) confirmed.add(row.conversation_id);
  }

  const quoted = await getPool().query<{ conversation_id: string }>(
    `SELECT DISTINCT conversation_id
       FROM documents
      WHERE tenant_id = $1 AND kind = 'quote'`,
    [tenantId],
  );
  const quotedDialogs = new Set<string>();
  for (const row of quoted.rows) quotedDialogs.add(row.conversation_id);

  if (quotedDialogs.size > 0) {
    const closed = await getPool().query<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id
         FROM escalations
        WHERE tenant_id = $1 AND status = 'closed'`,
      [tenantId],
    );
    for (const row of closed.rows) {
      if (quotedDialogs.has(row.conversation_id)) confirmed.add(row.conversation_id);
    }
  }

  return confirmed;
}

/**
 * Пробелы в базе знаний — только из записанных трасс.
 *
 * Источник: шаги `no_source` и `escalate` с причиной `no_confirmed_source`.
 * Каждый такой шаг — один вопрос, на который подтверждённого источника не
 * нашлось, поэтому счётчик считает шаги, а не диалоги: в одном диалоге
 * клиент мог задать несколько таких вопросов.
 *
 * Намерение берётся из самого шага, а если его там нет — из шага
 * классификации того же диалога: класс обращения пишет именно `classify`.
 */
async function readKnowledgeGaps(
  tenantId: string,
  dialogIntents: Map<string, string>,
): Promise<KnowledgeGap[]> {
  const result = await getPool().query<StepRow>(
    `SELECT conversation_id,
            node,
            outcome,
            metadata->>'intent' AS intent
       FROM agent_steps
      WHERE tenant_id = $1
        AND node IN ('no_source', 'escalate')
        AND metadata->>'reason' = 'no_confirmed_source'
      ORDER BY conversation_id, created_at ASC, id ASC`,
    [tenantId],
  );

  const grouped = new Map<string, KnowledgeGap>();
  for (const row of result.rows) {
    const intent = row.intent ?? dialogIntents.get(row.conversation_id) ?? "unknown";
    const key = `${intent}::${row.node}`;
    const entry = grouped.get(key) ?? { intent, node: row.node, count: 0 };
    entry.count += 1;
    grouped.set(key, entry);
  }

  return [...grouped.values()].sort(
    (left, right) => right.count - left.count || left.intent.localeCompare(right.intent),
  );
}

/**
 * GET /api/manager/analytics — метрики раздела «Аналитика».
 *
 * Тело ответа — в `snake_case` по контракту внешнего HTTP API.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const access = await checkManagerAccess({
    cookieHeader: request.headers.get("cookie"),
  });
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
    // Намерения диалогов нужны и пробелам в знаниях, и автозакрытию, поэтому
    // читаются первыми: остальные выборки идут параллельно.
    const dialogIntents = await readDialogIntents(tenantId);

    const [
      lastSteps,
      dialogCosts,
      firstMessages,
      manager,
      confirmedQuotes,
      gaps,
    ] = await Promise.all([
      readLastSteps(tenantId),
      readDialogCosts(tenantId),
      readFirstMessages(tenantId),
      readManagerParticipation(tenantId),
      readManagerConfirmedQuotes(tenantId),
      readKnowledgeGaps(tenantId, dialogIntents),
    ]);

    // Стоимость диалога: среднее, минимум и максимум по сумме шагов.
    const dialogIds = [...dialogCosts.keys()];
    const costs = dialogIds.map((id) => toNumber(dialogCosts.get(id)?.cost_rub));
    const totalRub = round4(costs.reduce((sum, value) => sum + value, 0));
    const avgRub = costs.length === 0 ? 0 : round4(totalRub / costs.length);
    const minRub = costs.length === 0 ? 0 : round4(Math.min(...costs));
    const maxRub = costs.length === 0 ? 0 : round4(Math.max(...costs));
    const tokensIn = dialogIds.reduce(
      (sum, id) => sum + toNumber(dialogCosts.get(id)?.tokens_in),
      0,
    );
    const tokensOut = dialogIds.reduce(
      (sum, id) => sum + toNumber(dialogCosts.get(id)?.tokens_out),
      0,
    );

    // Автозакрытие — по двум вариантам заказчика (docs/QA_new.md, вопрос 5).
    //
    // Вариант 1: ответ агента без менеджера — менеджер в диалоге не появился
    // и дело в его очередь не попало.
    // Вариант 2: КП, подтверждённое менеджером, — по диалогу выпущено
    // коммерческое предложение и менеджер его подтвердил.
    let withoutManager = 0;
    let withManagerConfirmedQuote = 0;
    for (const id of dialogIds) {
      const last = lastSteps.get(id);
      if (confirmedQuotes.has(id)) {
        withManagerConfirmedQuote += 1;
        continue;
      }
      if (last?.outcome === "respond" && !manager.touched.has(id)) {
        withoutManager += 1;
      }
    }
    const closedByAgent = withoutManager + withManagerConfirmedQuote;
    const share = dialogIds.length === 0 ? 0 : round4(closedByAgent / dialogIds.length);

    // Первый ответ: от первого сообщения клиента до первого ответа агента.
    const firstResponseSamples: number[] = [];
    for (const row of firstMessages.values()) {
      if (!row.first_client || !row.first_agent) continue;
      firstResponseSamples.push(row.first_agent.getTime() - row.first_client.getTime());
    }
    const avgFirstResponseMs =
      firstResponseSamples.length === 0
        ? 0
        : Math.round(
            firstResponseSamples.reduce((sum, value) => sum + value, 0) /
              firstResponseSamples.length,
          );

    // Происхождение данных: демонстрационный стенд — синтетика.
    const tenant = await getPool().query<{ slug: string }>(
      "SELECT slug FROM tenants WHERE id = $1",
      [tenantId],
    );
    const isDemo = tenant.rows[0]?.slug === DEMO_TENANT_SLUG;

    return Response.json({
      data_origin: isDemo ? "demo_synthetic" : "customer",
      origin_note: isDemo
        ? "Синтетические демонстрационные данные стенда, не данные заказчика."
        : "Данные установки заказчика.",
      cost: {
        dialogs: dialogIds.length,
        total_rub: totalRub,
        avg_rub: avgRub,
        min_rub: minRub,
        max_rub: maxRub,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      },
      auto_close: {
        dialogs_total: dialogIds.length,
        closed_by_agent: closedByAgent,
        share,
        without_manager: withoutManager,
        with_manager_confirmed_quote: withManagerConfirmedQuote,
      },
      first_response: {
        samples: firstResponseSamples.length,
        avg_ms: avgFirstResponseMs,
        target_ms: FIRST_RESPONSE_TARGET_MS,
        meets_target:
          firstResponseSamples.length > 0 && avgFirstResponseMs <= FIRST_RESPONSE_TARGET_MS,
      },
      knowledge_gaps: gaps,
    });
  } catch {
    return errorResponse(
      503,
      "upstream_unavailable",
      "Не удалось прочитать трассы агента",
      requestId,
    );
  }
}
