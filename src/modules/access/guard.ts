import { accessHttpStatus, checkAccess, type AccessDecision } from "./index";
import { BUDGET_EXHAUSTED_MESSAGE, checkDailyDialogs } from "../limits";

/**
 * Барьер доступа стенда: единый источник истины для HTTP-маршрутов.
 *
 * Модуль ничего не знает про Next.js: он принимает путь, адрес и cookie и
 * возвращает решение. HTTP-обвязка живёт в `src/middleware.ts`, поэтому
 * список закрытых маршрутов проверяется тестом, а не догадкой.
 *
 * Требования: docs/api-contract.md §11.1 (код доступа) и §11.2 (лимиты),
 * ADR-0009.
 */

/** Раздел ядра, к которому относится защищённый маршрут. */
export type ProtectedRoute = "chat" | "agent_run" | "kb_search" | "docs";

/**
 * Маршруты ядра, закрытые барьером доступа.
 *
 * `/v1/chat` — публичный путь контракта, он живёт до рерайза в
 * `/api/chat` (next.config.ts), поэтому в списке обе записи.
 */
export const PROTECTED_ROUTES: readonly { route: ProtectedRoute; path: string }[] = [
  { route: "chat", path: "/v1/chat" },
  { route: "chat", path: "/api/chat" },
  { route: "agent_run", path: "/api/agent/run" },
  { route: "kb_search", path: "/api/kb/search" },
  { route: "docs", path: "/api/docs" },
];

/** Понятные сообщения для каждого отказа барьера. */
const MESSAGES: Record<AccessDecision["reason"], string> = {
  ok: "",
  missing_code: "Требуется код доступа к стенду",
  invalid_code: "Код доступа не принят",
  rate_limited: "Превышен лимит запросов, попробуйте позже",
  daily_limit: "Превышен суточный лимит диалогов, попробуйте позже",
  budget_exhausted: BUDGET_EXHAUSTED_MESSAGE,
};

export type GuardRequest = {
  /** Путь запроса без строки запроса. */
  pathname: string;
  /**
   * Ключ клиента для лимита запросов в минуту.
   *
   * Обычно это адрес клиента, но адрес из заголовка подделать можно, поэтому
   * ключ определяет `clientBucketKey` (`src/modules/access/client-ip.ts`):
   * за обратным прокси — адрес, без прокси — подписанная сессия доступа.
   */
  ip: string;
  /** Заголовок `Cookie` целиком: в нём и код доступа, и cookie диалога. */
  cookieHeader: string | null;
  /** Диалог ещё не начат: cookie `support_conversation` не выдана. */
  newConversation: boolean;
};

export type GuardDecision =
  | { allowed: true; route: ProtectedRoute | null }
  | {
      allowed: false;
      status: number;
      code: string;
      message: string;
      retryAfterSeconds: number | null;
    };

/**
 * Раздел ядра по пути запроса; `null` — путь не защищён барьером.
 *
 * Совпадение точное или по префиксу с границей сегмента: `/api/docs/quote`
 * защищён, а `/api/docsomething` — нет.
 */
export function matchProtectedRoute(pathname: string): ProtectedRoute | null {
  for (const { route, path } of PROTECTED_ROUTES) {
    if (pathname === path || pathname.startsWith(`${path}/`)) {
      return route;
    }
  }
  return null;
}

/** Решение барьера по решению модуля доступа. */
function denied(decision: AccessDecision): GuardDecision {
  const status = accessHttpStatus(decision);
  return {
    allowed: false,
    status,
    code: status === 429 ? "rate_limited" : "unauthorized",
    message: MESSAGES[decision.reason],
    retryAfterSeconds: decision.retryAfterSeconds,
  };
}

/**
 * Барьер защищённого маршрута.
 *
 * Порядок проверок: код доступа → лимит запросов по IP → суточный лимит
 * диалогов → потолок расхода модели. Лимит запросов считается и для
 * запросов без кода: иначе посторонний обходил бы его, не присылая код.
 *
 * Квота диалога списывается только новым диалогом: запрос внутри уже
 * начатого диалога её не расходует.
 */
export async function guardRequest(request: GuardRequest): Promise<GuardDecision> {
  const route = matchProtectedRoute(request.pathname);
  if (route === null) {
    return { allowed: true, route: null };
  }

  const access = await checkAccess({
    ip: request.ip,
    cookieHeader: request.cookieHeader,
  });
  if (!access.allowed) {
    return denied(access);
  }

  if (route === "chat" && request.newConversation) {
    const dialog = await checkDailyDialogs();
    if (!dialog.allowed) {
      return {
        allowed: false,
        status: 429,
        code: "rate_limited",
        message: MESSAGES.daily_limit,
        retryAfterSeconds: dialog.retryAfterSeconds,
      };
    }
  }

  return { allowed: true, route };
}
