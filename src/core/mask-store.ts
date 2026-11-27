/**
 * Минимальный контракт пула: маскирование работает и с настоящим пулом, и с
 * тестовым. Модуль не зависит от конкретной реализации соединения.
 */
export type MaskPoolLike = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Таблица соответствий меток ПД по диалогам.
 *
 * Маскировщик заменяет персональные данные метками вида ⟦PERSON_1⟧, и
 * модель получает только метки. Исходные значения лежат в этой таблице и
 * подставляются в ответ кодом перед отправкой клиенту: клиент законно
 * получает свои же данные обратно.
 *
 * Таблица соответствий не попадает ни в модель, ни в трассу, ни в логи.
 */

export type MaskMappingStore = {
  /** Читает соответствия меток диалога. */
  load(conversationId: string): Promise<Record<string, string>>;
  /** Добавляет новые соответствия, не трогая уже сохранённые. */
  save(conversationId: string, mapping: Record<string, string>): Promise<void>;
};

export function createMaskMappingStore(pool: MaskPoolLike): MaskMappingStore {
  return {
    async load(conversationId: string): Promise<Record<string, string>> {
      const result = await pool.query(
        `SELECT label, value
           FROM conversation_mask
          WHERE conversation_id = $1`,
        [conversationId],
      );
      const mapping: Record<string, string> = {};
      for (const row of result.rows) {
        mapping[String(row.label)] = String(row.value);
      }
      return mapping;
    },

    async save(conversationId: string, mapping: Record<string, string>): Promise<void> {
      for (const [label, value] of Object.entries(mapping)) {
        await pool.query(
          `INSERT INTO conversation_mask (conversation_id, label, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (conversation_id, label) DO NOTHING`,
          [conversationId, label, value],
        );
      }
    },
  };
}
