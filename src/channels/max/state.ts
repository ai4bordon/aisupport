import { Pool } from "pg";

import type { MaxChannelState, MaxChannelStateStore } from "./adapter";

/**
 * Состояние канала в базе.
 *
 * Маркер опроса сохраняется между перезапусками, чтобы перезапуск адаптера
 * не терял события: без маркера `GET /updates` вернул бы уже обработанные
 * события повторно.
 *
 * Таблица `channel_state` — миграция `db/migrations/5000_channel_state.sql`.
 * Строка с пустым `external_chat_id` хранит состояние канала целиком.
 */

const CHANNEL = "max";
const CHANNEL_SCOPE = "";

export type PoolLike = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

export type ChannelStateStoreOptions = {
  /** Арендатор: `tenant_id` берётся сервером, не из тела запроса. */
  tenantId: string;
};

export function createChannelStateStore(
  pool: PoolLike,
  options: ChannelStateStoreOptions,
): MaxChannelStateStore {
  const { tenantId } = options;
  return {
    async load(): Promise<MaxChannelState> {
      const result = await pool.query(
        `SELECT marker, last_event_at, shadow_mode
           FROM channel_state
          WHERE tenant_id = $1 AND channel = $2 AND external_chat_id = $3`,
        [tenantId, CHANNEL, CHANNEL_SCOPE],
      );
      const row = result.rows[0];
      if (!row) {
        return { marker: null, lastEventAt: null, shadowMode: false };
      }
      return {
        marker: row.marker === null || row.marker === undefined ? null : Number(row.marker),
        lastEventAt: row.last_event_at ? new Date(row.last_event_at as string).toISOString() : null,
        shadowMode: Boolean(row.shadow_mode),
      };
    },

    async save(state: MaxChannelState): Promise<void> {
      await pool.query(
        `INSERT INTO channel_state (tenant_id, channel, external_chat_id, marker, last_event_at, shadow_mode, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (tenant_id, channel, external_chat_id)
         DO UPDATE SET marker = EXCLUDED.marker,
                       last_event_at = EXCLUDED.last_event_at,
                       shadow_mode = EXCLUDED.shadow_mode,
                       updated_at = now()`,
        [
          tenantId,
          CHANNEL,
          CHANNEL_SCOPE,
          state.marker,
          state.lastEventAt,
          state.shadowMode,
        ],
      );
    },
  };
}

/**
 * Пул для хранилища состояния канала.
 *
 * Строка подключения — только из переменной окружения `DATABASE_URL`.
 */
export function createStatePool(): PoolLike {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL не задан");
  }
  // `pg` подключается лениво: пул создаётся, но соединение не открывается,
  // пока не понадобится запрос.
  const pool = new Pool({ connectionString });
  return {
    query: async (text: string, values: unknown[] = []) => {
      const result = await pool.query(text, values);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    end: async () => {
      await pool.end();
    },
  };
}
