import {
  ACCESS_COOKIE_NAME,
  readAccessSession,
  readCookieValue,
  signAccessSession,
  verifyAccessCode,
  type AccessSession,
} from "./session";
import { checkDailyDialogs, checkModelBudget, checkRateLimit } from "../limits";

export { ACCESS_COOKIE_NAME, readAccessSession, signAccessSession, verifyAccessCode };
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

/**
 * Барьер доступа стенда: без действующей cookie запрос не доходит до ядра.
 *
 * Неавторизованный запрос не расходует квоту и не трогает счётчики —
 * иначе посторонний выжигал бы лимит диалогов стенда. Счётчики растут
 * только на авторизованных запросах.
 */
export async function checkAccess(request: AccessRequest): Promise<AccessDecision> {
  const cookieHeader = request.cookieHeader ?? null;
  const raw = readCookieValue(cookieHeader, ACCESS_COOKIE_NAME);
  if (!raw) {
    return { allowed: false, reason: "missing_code", retryAfterSeconds: null };
  }
  if (!readAccessSession(cookieHeader)) {
    return { allowed: false, reason: "invalid_code", retryAfterSeconds: null };
  }

  const rate = await checkRateLimit(request.ip);
  if (!rate.allowed) {
    return {
      allowed: false,
      reason: rate.reason === "rate_limited" ? "rate_limited" : "daily_limit",
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }

  const daily = await checkDailyDialogs();
  if (!daily.allowed) {
    return { allowed: false, reason: "daily_limit", retryAfterSeconds: daily.retryAfterSeconds };
  }

  const budget = await checkModelBudget();
  if (!budget.allowed) {
    return { allowed: false, reason: "budget_exhausted", retryAfterSeconds: null };
  }

  return { allowed: true, reason: "ok", retryAfterSeconds: null };
}

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
