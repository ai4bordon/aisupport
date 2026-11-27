import { NextResponse } from "next/server";

import { createChannelStateStore, createStatePool } from "@/channels/max";
import { getTenantId } from "@/db/tenant";
import { accessHttpStatus, checkAccess } from "@/modules/access";
import { isShadowMode } from "@/core/shadow-mode";

/**
 * `GET /api/demo/max-feed` — живая лента канала MAX для экрана демо `/start`.
 *
 * Лента показывает последние сообщения канала `max` из нашей базы: только
 * маскированный текст (`text_masked`), роль, время и идентификатор диалога.
 * Исходный текст (`text_original`) не читается и в ответ не попадает, токены
 * и ключи не раскрываются.
 *
 * Арендатор определяется сервером (`src/db/tenant.ts`), из тела запроса не
 * принимается. Пустое состояние — пустой массив и признак `empty`, а не
 * ошибка: на демо лента может быть пустой, и это не поломка.
 *
 * Барьер доступа на `/api/demo/*` мидлваре не навешивает, поэтому проверка
 * клиентского кода (`support_access`) делается здесь через общий `checkAccess`.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** Канал, из которого берётся лента. */
const CHANNEL = "max";

/** Сколько последних сообщений показывается в ленте. */
const FEED_LIMIT = 20;

/** Имя бота MAX в публичной ссылке. */
const BOT_USERNAME = "se15151074_bot";

/** Публичная ссылка на бота: формат `max.ru/<никнейм>`. */
const BOT_LINK = `https://max.ru/${BOT_USERNAME}`;

/** Сообщение ленты в безопасном виде. */
type FeedMessage = {
  text_masked: string;
  role: string;
  created_at: string;
  conversation_id: string;
};

/** Статус канала: что видно про воркер и настройки арендатора. */
type FeedStatus = {
  published: boolean;
  worker_listening: boolean;
  marker: number | null;
  last_event_at: string | null;
  shadow_mode: boolean;
};

type FeedBody = {
  bot: { username: string; link: string };
  status: FeedStatus;
  messages: FeedMessage[];
  empty: boolean;
};

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { error: { code, message, details: {}, request_id: crypto.randomUUID() } },
    { status, headers: JSON_HEADERS },
  );
}

/**
 * Последние сообщения канала MAX.
 *
 * Сортировка по времени создания — от свежих к старым: лента читается сверху
 * вниз, и порядок должен совпадать с порядком диалога.
 */
async function loadMessages(
  pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
): Promise<FeedMessage[]> {
  const result = await pool.query(
    `SELECT m.text_masked, m.role, m.created_at, m.conversation_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.tenant_id = $1 AND c.channel = $2
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [tenantId, CHANNEL, FEED_LIMIT],
  );

  return result.rows.map((row) => {
    const record = row as {
      text_masked: string;
      role: string;
      created_at: Date | string;
      conversation_id: string;
    };
    return {
      text_masked: record.text_masked,
      role: record.role,
      created_at:
        record.created_at instanceof Date
          ? record.created_at.toISOString()
          : new Date(record.created_at).toISOString(),
      conversation_id: record.conversation_id,
    };
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const decision = await checkAccess({
    cookieHeader: request.headers.get("cookie"),
    ip: request.headers.get("x-forwarded-for") ?? "0.0.0.0",
  });
  if (!decision.allowed) {
    return errorResponse(
      accessHttpStatus(decision),
      decision.reason,
      "Лента MAX доступна по коду демонстрационного стенда",
    );
  }

  const pool = createStatePool();
  try {
    const tenantId = await getTenantId();
    const store = createChannelStateStore(pool, { tenantId });
    const state = await store.load();

    const messages = await loadMessages(pool, tenantId);
    const shadowMode = await isShadowMode(pool, tenantId);

    const body: FeedBody = {
      bot: { username: BOT_USERNAME, link: BOT_LINK },
      status: {
        // Бот опубликован и доступен клиентам в MAX: по этому же адресу
        // открывается публичная страница бота.
        published: true,
        // Воркер слушает, когда в `channel_state` есть маркер опроса:
        // маркер сохраняется воркером и без него опрос не идёт.
        worker_listening: state.marker !== null,
        marker: state.marker,
        last_event_at: state.lastEventAt,
        shadow_mode: shadowMode,
      },
      messages,
      empty: messages.length === 0,
    };

    return NextResponse.json(body, { status: 200, headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "неизвестная ошибка";
    return errorResponse(500, "internal_error", `Лента MAX недоступна: ${message}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
