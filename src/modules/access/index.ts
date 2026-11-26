import {
  ACCESS_COOKIE_NAME,
  MANAGER_COOKIE_NAME,
  readAccessSession,
  readCookieValue,
  readManagerSession,
  signAccessSession,
  verifyAccessCode,
  verifyManagerCode,
  type AccessSession,
} from "./session";
import {
  checkDailyDialogs,
  checkModelBudget,
  checkRateLimit,
  peekDailyDialogs,
} from "../limits";

export {
  ACCESS_COOKIE_NAME,
  MANAGER_COOKIE_NAME,
  readAccessSession,
  readManagerSession,
  signAccessSession,
  verifyAccessCode,
  verifyManagerCode,
};
export type { AccessSession };

/** Решение барьера доступа — форма из контракта `docs/api-contract.md` §0.3. */
export type AccessDecision = {
  allowed: boolean;
  reason:
    | "ok"
    | "missing_code"
    | "invalid_code"
    | "rate_limited"
    | "daily_limit"
    | "budget_exhausted";
  retryAfterSeconds: number | null;
};

export type AccessRequest = {
  cookieHeader?: string | null;
  ip: string;
};

/** HTTP-статус для решения барьера — по таблице ошибок контракта §2. */
export function accessHttpStatus(decision: AccessDecision): number {
  switch (decision.reason) {
    case "ok":
      return 200;
    case "rate_limited":
    case "daily_limit":
    case "budget_exhausted":
      return 429;
    default:
      return 401;
  }
}

/**
 * Барьер доступа стенда: без действующей cookie запрос не доходит до ядра.
 *
 * Лимит запросов по IP считается для всех запросов, включая неавторизованные:
 * иначе посторонний обходил бы его, отправляя запросы без кода. Лимит диалогов
 * при этом не расходуется: запрос без кода не создаёт диалог.
 */
export async function checkAccess(request: AccessRequest): Promise<AccessDecision> {
  const cookieHeader = request.cookieHeader ?? null;
  const raw = readCookieValue(cookieHeader, ACCESS_COOKIE_NAME);
  if (!raw) {
    const rate = await checkRateLimit(request.ip);
    return {
      allowed: false,
      reason: rate.allowed ? "missing_code" : "rate_limited",
      retryAfterSeconds: rate.allowed ? null : rate.retryAfterSeconds,
    };
  }
  if (!readAccessSession(cookieHeader)) {
    const rate = await checkRateLimit(request.ip);
    return {
      allowed: false,
      reason: rate.allowed ? "invalid_code" : "rate_limited",
      retryAfterSeconds: rate.allowed ? null : rate.retryAfterSeconds,
    };
  }

  const rate = await checkRateLimit(request.ip);
  if (!rate.allowed) {
    return { allowed: false, reason: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds };
  }

  // Диалоги читаются без увеличения: запрос не равен диалогу, квоту
  // диалога списывает сам запуск диалога на стороне ядра.
  const daily = await peekDailyDialogs();
  if (!daily.allowed) {
    return { allowed: false, reason: "daily_limit", retryAfterSeconds: daily.retryAfterSeconds };
  }

  const budget = await checkModelBudget();
  if (!budget.allowed) {
    return { allowed: false, reason: "budget_exhausted", retryAfterSeconds: null };
  }

  return { allowed: true, reason: "ok", retryAfterSeconds: null };
}

/**
 * Барьер кабинета менеджера.
 *
 * Кабинет требует отдельного кода менеджера поверх общего кода стенда:
 * cookie стенда в кабинет не пускает (R17).
 */
export async function checkManagerAccess(
  request: AccessRequest,
): Promise<AccessDecision> {
  const cookieHeader = request.cookieHeader ?? null;
  const raw = readCookieValue(cookieHeader, MANAGER_COOKIE_NAME);
  if (!raw) {
    return { allowed: false, reason: "missing_code", retryAfterSeconds: null };
  }
  if (!readManagerSession(cookieHeader)) {
    return { allowed: false, reason: "invalid_code", retryAfterSeconds: null };
  }
  return { allowed: true, reason: "ok", retryAfterSeconds: null };
}
