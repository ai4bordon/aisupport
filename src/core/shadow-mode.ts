import { randomUUID } from "node:crypto";

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
 * Вход записи очереди режима тени.
 *
 * Секреты, сырые персональные данные и полный payload трассы в него не
 * принимаются: тип не даёт им попасть в очередь.
 */
export type ShadowDraftInput = {
  /** Арендатор: запись очереди видна только ему. */
  tenantId: string;
  /** Диалог, к которому относится результат. */
  conversationId: string;
  /** Канал, из которого пришёл результат. */
  channel: "web" | "max";
  /** Резюме для менеджера. */
  summary: string;
  /** Результат: черновик ответа или резюме эскалации. */
  result: string;
  /** Безопасные метаданные источников ответа. */
  sources: ShadowSource[];
  /** Безопасная ссылка на трассу: идентификатор диалога. */
  traceRef: string;
};

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
  const sources = input.sources.map((source) => ({
    kind: source.kind,
    id: source.id,
    title: source.title,
    location: source.location ?? null,
  }));

  const result = await pool.query(
    `INSERT INTO escalations (
       tenant_id, conversation_id, reason, summary, draft, result,
       sources, channel, trace_ref, status
     )
     VALUES ($1, $2, $3, $4, $5, $5, $6::jsonb, $7, $8, 'open')
     RETURNING id`,
    [
      input.tenantId,
      input.conversationId,
      SHADOW_REASON,
      input.summary,
      input.result,
      JSON.stringify(sources),
      input.channel,
      input.traceRef,
    ],
  );

  const row = result.rows[0] as { id?: string } | undefined;
  return row?.id ?? randomUUID();
}
