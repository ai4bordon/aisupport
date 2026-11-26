import { NextResponse } from "next/server";

import { getMaxStatus } from "@/channels/max";

/**
 * Состояние подключения канала MAX — для демо.
 *
 * Отдаёт: работает ли опрос, когда было последнее событие, включён ли режим
 * тени. Токен бота не раскрывается.
 */
export async function GET(): Promise<NextResponse> {
  const status = await getMaxStatus();
  return NextResponse.json(status);
}
