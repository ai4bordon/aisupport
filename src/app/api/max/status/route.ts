import { NextResponse } from "next/server";

import { createChannelStateStore, createStatePool } from "@/channels/max";
import { getTenantId } from "@/db/tenant";

/**
 * Состояние подключения канала MAX — для демо.
 *
 * Отдаёт: работает ли опрос, когда было последнее событие, включён ли режим
 * тени. Токен бота не раскрывается.
 *
 * Состояние читается из таблицы `channel_state`, а не из процесса приложения:
 * опрос MAX идёт отдельным процессом (воркером), поэтому в процессе Next.js
 * сессии адаптера нет. Без чтения из базы статус всегда показывал бы
 * «опрос не работает» — даже когда воркер опрашивает события.
 */
export async function GET(): Promise<NextResponse> {
  const pool = createStatePool();
  try {
    const tenantId = await getTenantId();
    const store = createChannelStateStore(pool, { tenantId });
    const state = await store.load();
    return NextResponse.json({
      running: state.marker !== null,
      lastEventAt: state.lastEventAt,
      lastMarker: state.marker,
      shadowMode: state.shadowMode,
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
