import { NextResponse, type NextRequest } from "next/server";

import { clientBucketKey } from "@/modules/access/client-ip";
import { guardRequest } from "@/modules/access/guard";
import { readConversationId } from "@/core/session";

/**
 * Барьер доступа и лимиты стенда (docs/api-contract.md §11.1–§11.2,
 * ADR-0009).
 *
 * Барьер живёт в middleware, а не в каждом маршруте: список закрытых
 * маршрутов тогда один, и новый маршрут ядра нельзя забыть закрыть —
 * список проверяется тестом `tests/access/audit-access-gate.test.ts`.
 */

/**
 * Рантайм — Node.js, а не Edge.
 *
 * Счётчики лимитов лежат в PostgreSQL, а драйвер `pg` в Edge-рантайме не
 * работает: без этого объявления Next собрал бы барьер под Edge и запрос
 * падал бы с ошибкой драйвера вместо ответа лимита.
 */
export const runtime = "nodejs";

/**
 * Список закрытых маршрутов — тот же, что у модуля доступа.
 *
 * Дублирование нужно только потому, что `config.matcher` читается Next.js
 * статически: список в модуле недоступен анализатору сборки. Значения
 * совпадают с `PROTECTED_ROUTES` в `src/modules/access/guard.ts`, и
 * расхождение ломает тест.
 */
export const config = {
  matcher: [
    "/v1/chat",
    "/v1/chat/:path*",
    "/api/chat",
    "/api/chat/:path*",
    "/api/agent/run",
    "/api/agent/run/:path*",
    "/api/kb/search",
    "/api/kb/search/:path*",
    "/api/docs/:path*",
  ],
};

/**
 * Адрес клиента для лимита запросов в минуту.
 *
 * Заголовок `x-forwarded-for` подставляет сам клиент, поэтому доверять ему
 * всегда нельзя: подмена заголовка обходила бы лимит. Доверие включается
 * переменной `ALLOW_PROXY_HEADERS=1` — только когда стенд действительно
 * стоит за обратным прокси.
 *
 * Правило живёт в модуле доступа (`src/modules/access/client-ip.ts`):
 * там же записано, почему без прокси адрес соединения недоступен и все
 * клиенты делят один счётчик.
 */
export { clientIp, clientBucketKey } from "@/modules/access/client-ip";

/** Тело ошибки по контракту §2. */
function errorBody(code: string, message: string, requestId: string): string {
  return JSON.stringify({
    error: {
      code,
      message,
      details: {},
      request_id: requestId,
    },
  });
}

/**
 * Барьер доступа для защищённых маршрутов.
 *
 * Без действующей cookie `support_access` запрос не доходит до ядра:
 * `401 unauthorized`. Превышение лимитов — `429 rate_limited` с
 * `Retry-After`.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  // Новый диалог — cookie `support_conversation` ещё не выдана: именно он
  // расходует суточную квоту диалогов.
  const cookieHeader = request.headers.get("cookie");
  const newConversation = readConversationId(cookieHeader ?? undefined) === null;

  const decision = await guardRequest({
    pathname: request.nextUrl.pathname,
    // Ключ лимита запросов: за обратным прокси — адрес клиента, без
    // прокси — подписанная сессия, потому что заголовок с адресом
    // подставляет сам клиент.
    ip: clientBucketKey({ headers: request.headers, cookieHeader }),
    cookieHeader,
    newConversation,
  });

  if (decision.allowed) {
    return NextResponse.next();
  }

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (decision.retryAfterSeconds !== null) {
    headers["retry-after"] = String(decision.retryAfterSeconds);
  }

  return new NextResponse(errorBody(decision.code, decision.message, requestId), {
    status: decision.status,
    headers,
  });
}
