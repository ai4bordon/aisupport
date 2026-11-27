/**
 * Режим тени: единая настройка и очередь менеджера (ADR-0008, R10).
 *
 * Настройка одна на оба канала и лежит в `tenants.shadow_mode`. Кэшировать её
 * в процессе нельзя: переключение должно действовать на новую обработку без
 * перезапуска, поэтому каждый канал читает значение из базы в начале своей
 * обработки.
 *
 * Запись очереди — строка `escalations` с каналом, диалогом, причиной,
 * результатом и безопасной ссылкой на трассу. Безопасная ссылка — это
 * идентификатор диалога: UUID, по которому трасса ищется в `agent_steps`.
 * Полные внутренние журналы, токены и сырые персональные данные в очередь
 * не попадают.
 */

/** Причина записи очереди, созданной режимом тени. */
export const SHADOW_REASON = "shadow_mode";

/**
 * Пул, которым работает сервис.
 *
 * Достаточно одного `query`: сервис не открывает транзакций и не держит
 * соединений, поэтому его можно вызывать и из маршрута, и из воркера.
 */
export type ShadowPool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/**
 * Источник ответа в безопасном виде.
 *
 * В очередь попадают только метаданные источника: текст источника в
 * записи очереди не нужен, а полный текст статьи — это лишнее в очереди
 * менеджера.
 */
export type ShadowSource = {
  kind: string;
  id: string;
  title: string;
  location?: string | null;
};

/**
 * Вход записи очереди менеджера.
 *
 * Секреты, сырые персональные данные и полный payload трассы в него не
 * принимаются: тип не даёт им попасть в очередь.
 */
export type ManagerQueueInput = {
  /** Арендатор: запись очереди видна только ему. */
  tenantId: string;
  /** Диалог, к которому относится результат. */
  conversationId: string;
  /** Канал, из которого пришёл результат. */
  channel: "web" | "max";
  /** Причина: `shadow_mode` или причина исходной эскалации. */
  reason: string;
  /** Резюме для менеджера. */
  summary: string;
  /** Результат: черновик ответа или резюме эскалации. */
  result: string;
  /** Черновик ответа. */
  draft: string | null;
  /** Безопасные метаданные источников ответа. */
  sources: ShadowSource[];
  /** Безопасная ссылка на трассу: идентификатор диалога. */
  traceRef: string;
  /**
   * Признак теневой записи: результат сохранён режимом тени и клиенту не
   * отправлен.
   *
   * Отдельный признак, а не значение причины: причина исходной эскалации
   * нужна менеджеру сама по себе, а менеджер должен ещё видеть, что запись
   * пришла из режима тени, а не из обычной эскалации.
   */
  isShadow?: boolean;
};

/**
 * Вход записи очереди, созданной режимом тени.
 *
 * Отдельный тип от `ManagerQueueInput`: у теневой записи причина всегда
 * `shadow_mode`, и callers не могут её переопределить.
 */
export type ShadowDraftInput = Omit<ManagerQueueInput, "reason" | "draft">;

/**
 * Режим тени для арендатора.
 *
 * Читается только `tenants.shadow_mode`: дублирующее поле
 * `channel_state.shadow_mode` миграция 6300 удалила, иначе веб-чат и MAX
 * могли бы показывать разные значения одной настройки.
 */
export async function isShadowMode(pool: ShadowPool, tenantId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT shadow_mode FROM tenants WHERE id = $1",
    [tenantId],
  );
  const row = result.rows[0] as { shadow_mode?: unknown } | undefined;
  return Boolean(row?.shadow_mode);
}

/**
 * Запись результата в очередь менеджера.
 *
 * Одна запись на один результат ядра: повторная запись создала бы в очереди
 * дубликат, и менеджер увидел бы один и тот же вопрос дважды.
 *
 * Причина записи — `shadow_mode`: результат сохранён, но клиенту не
 * отправлен. Если ядро вернуло эскалацию, её собственная причина не теряется:
 * она указана в резюме.
 */
export async function recordShadowDraft(
  pool: ShadowPool,
  input: ShadowDraftInput,
): Promise<string> {
  return recordManagerQueue(pool, {
    ...input,
    reason: SHADOW_REASON,
    draft: input.result,
    // Признак тени ставится здесь, а не выводится из причины: запись с
    // исходной причиной эскалации тоже пришла из режима тени, но её причина
    // остаётся настоящей.
    isShadow: true,
  });
}

/**
 * Запись в очередь менеджера с произвольной причиной.
 *
 * Причина исходной эскалации не переписывается: наличие черновика в очереди
 * не превращает эскалацию в разрешение отправить ответ клиенту, и менеджер
 * должен видеть настоящую причину.
 */
export async function recordManagerQueue(
  pool: ShadowPool,
  input: ManagerQueueInput,
): Promise<string> {
  return insertQueueRecord(pool, {
    ...input,
    isShadow: input.isShadow === true,
  });
}

/**
 * Единая точка записи в очередь менеджера.
 *
 * Запись идемпотентна: уникальный индекс
 * `(conversation_id, trace_ref, is_shadow, dedupe_key)` не даёт создать
 * вторую строку для того же результата ядра. При повторной доставке хода
 * возвращается идентификатор уже существующей записи, а не новый.
 *
 * Если строка не вставлена и не найдена — это сбой записи, а не успех:
 * функция бросает исключение. Выдуманный идентификатор клиенту не
 * возвращается: ссылка на запись очереди всегда ведёт в базу.
 */
async function insertQueueRecord(
  pool: ShadowPool,
  input: ManagerQueueInput & { isShadow: boolean },
): Promise<string> {
  const sources = input.sources.map((source) => ({
    kind: source.kind,
    id: source.id,
    title: source.title,
    location: source.location ?? null,
  }));

  const values = [
    input.tenantId,
    input.conversationId,
    input.reason,
    input.summary,
    input.draft,
    input.result,
    JSON.stringify(sources),
    input.channel,
    input.traceRef,
    input.isShadow,
  ];

  const result = await pool.query(
    `INSERT INTO escalations (
       tenant_id, conversation_id, reason, summary, draft, result,
       sources, channel, trace_ref, status, is_shadow
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'open', $10)
     ON CONFLICT (conversation_id, trace_ref, is_shadow, dedupe_key) DO NOTHING
     RETURNING id`,
    values,
  );

  const inserted = result.rows[0] as { id?: string } | undefined;
  if (inserted?.id) {
    return inserted.id;
  }

  // Строка уже была: возвращается её идентификатор, чтобы повторная
  // доставка хода дала клиенту ту же рабочую ссылку на запись очереди.
  // Отпечаток содержимого считает та же функция, на которой построен
  // уникальный индекс: выражения не могут разойтись.
  const existing = await pool.query(
    `SELECT id FROM escalations
      WHERE conversation_id = $1
        AND trace_ref = $2
        AND is_shadow = $3
        AND dedupe_key = escalation_dedupe_key($4, $5, $6, $7, $8, $9::jsonb)
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [
      input.conversationId,
      input.traceRef,
      input.isShadow,
      input.reason,
      input.summary,
      input.result,
      input.draft,
      input.channel,
      JSON.stringify(sources),
    ],
  );

  const row = existing.rows[0] as { id?: string } | undefined;
  if (!row?.id) {
    throw new Error(
      "Запись в очередь менеджера не создана и не найдена: результат ядра потерян",
    );
  }
  return row.id;
}
