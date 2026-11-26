import {
  addSpend,
  closePool,
  dayWindowStart,
  hourWindowStart,
  incrementCounter,
  ipBucketKey,
  minuteWindowStart,
  readCounter,
  STAND_BUCKET_KEY,
} from "./counters";

export { closePool };

export type RateLimitDecision = {
  allowed: boolean;
  reason: "ok" | "rate_limited" | "daily_limit";
  retryAfterSeconds: number | null;
  limit: number;
};

export type BudgetDecision = {
  allowed: boolean;
  reason: "ok" | "budget_exhausted";
  spentHour: number;
  spentDay: number;
  limitHour: number;
  limitDay: number;
};

/** Рабочие допущения контракта §11.2, если переменная окружения не задана. */
export const DEFAULT_REQUESTS_PER_MINUTE = 10;
export const DEFAULT_DAILY_DIALOG_LIMIT = 50;
export const DEFAULT_MODEL_BUDGET_PER_HOUR_RUB = 30;
export const DEFAULT_MODEL_BUDGET_PER_DAY_RUB = 300;

/**
 * Сообщение для исчерпанного бюджета: пользователь получает понятный текст,
 * а не ошибку сервера (контракт §11.2).
 */
export const BUDGET_EXHAUSTED_MESSAGE = "Лимит демо исчерпан, попробуйте позже";

function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function requestsPerMinute(): number {
  return limitFromEnv("REQUESTS_PER_MINUTE", DEFAULT_REQUESTS_PER_MINUTE);
}

export function dailyDialogLimit(): number {
  return limitFromEnv("DAILY_DIALOG_LIMIT", DEFAULT_DAILY_DIALOG_LIMIT);
}

export function modelBudgetPerHourRub(): number {
  return limitFromEnv("MODEL_BUDGET_PER_HOUR_RUB", DEFAULT_MODEL_BUDGET_PER_HOUR_RUB);
}

export function modelBudgetPerDayRub(): number {
  return limitFromEnv("MODEL_BUDGET_PER_DAY_RUB", DEFAULT_MODEL_BUDGET_PER_DAY_RUB);
}

function secondsUntil(target: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - Date.now()) / 1000));
}

/**
 * Проверка лимита запросов: 10 запросов в минуту на IP.
 *
 * Окно — календарная минута, ключ — отпечаток IP. Решение принимается
 * после атомарного увеличения счётчика, поэтому конкурентные запросы
 * с одного IP не проходят лимит.
 */
export async function checkRateLimit(ip: string): Promise<RateLimitDecision> {
  const limit = requestsPerMinute();
  const now = new Date();
  const windowStart = minuteWindowStart(now);
  const counter = await incrementCounter("requests_minute", ipBucketKey(ip), windowStart);

  if (counter <= limit) {
    return { allowed: true, reason: "ok", retryAfterSeconds: null, limit };
  }
  const nextMinute = new Date(windowStart);
  nextMinute.setUTCMinutes(nextMinute.getUTCMinutes() + 1);
  return {
    allowed: false,
    reason: "rate_limited",
    retryAfterSeconds: secondsUntil(nextMinute),
    limit,
  };
}

/**
 * Проверка суточного лимита диалогов: 50 диалогов на стенд за сутки.
 *
 * Счётчик общий для всех cookie и не привязан к сессии, поэтому повторный
 * ввод кода и новая вкладка не создают новую квоту.
 */
export async function checkDailyDialogs(): Promise<RateLimitDecision> {
  const limit = dailyDialogLimit();
  const now = new Date();
  const windowStart = dayWindowStart(now);
  const counter = await incrementCounter("dialogs_daily", STAND_BUCKET_KEY, windowStart);

  if (counter <= limit) {
    return { allowed: true, reason: "ok", retryAfterSeconds: null, limit };
  }
  const nextDay = new Date(windowStart);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    allowed: false,
    reason: "daily_limit",
    retryAfterSeconds: secondsUntil(nextDay),
    limit,
  };
}

/**
 * Чтение суточного счётчика диалогов без увеличения.
 *
 * Проверка лимита не равна запуску диалога: запрос к барьеру не должен
 * расходовать квоту диалога, иначе один диалог из нескольких запросов
 * съедал бы счётчик.
 */
export async function peekDailyDialogs(): Promise<RateLimitDecision> {
  const limit = dailyDialogLimit();
  const now = new Date();
  const windowStart = dayWindowStart(now);
  const counter = await readCounter("dialogs_daily", STAND_BUCKET_KEY, windowStart);

  if (counter.counter < limit) {
    return { allowed: true, reason: "ok", retryAfterSeconds: null, limit };
  }
  const nextDay = new Date(windowStart);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    allowed: false,
    reason: "daily_limit",
    retryAfterSeconds: secondsUntil(nextDay),
    limit,
  };
}

/**
 * Проверка бюджета модели: 30 ₽ в час и 300 ₽ в сутки.
 *
 * Потолок применяется к часовому окну: при его достижении новые вызовы
 * модели запрещены, текущие диалоги завершаются без новых вызовов.
 */
export async function checkModelBudget(): Promise<BudgetDecision> {
  const limitHour = modelBudgetPerHourRub();
  const limitDay = modelBudgetPerDayRub();
  const now = new Date();

  const hour = await readCounter("model_budget_hour", STAND_BUCKET_KEY, hourWindowStart(now));
  const day = await readCounter("model_budget_day", STAND_BUCKET_KEY, dayWindowStart(now));

  if (hour.spendRub >= limitHour || day.spendRub >= limitDay) {
    return {
      allowed: false,
      reason: "budget_exhausted",
      spentHour: hour.spendRub,
      spentDay: day.spendRub,
      limitHour,
      limitDay,
    };
  }
  return {
    allowed: true,
    reason: "ok",
    spentHour: hour.spendRub,
    spentDay: day.spendRub,
    limitHour,
    limitDay,
  };
}

/**
 * Учёт расхода модели.
 *
 * Вызывается только после успешного вызова модели: при ошибке провайдера
 * 429 или 402 стоимость неуспешного вызова равна нулю, поэтому повторная
 * обработка ответа не списывает лимит повторно.
 */
export async function recordModelSpend(costRub: number): Promise<void> {
  if (!Number.isFinite(costRub) || costRub <= 0) {
    return;
  }
  const now = new Date();
  await addSpend("model_budget_hour", STAND_BUCKET_KEY, hourWindowStart(now), costRub);
  await addSpend("model_budget_day", STAND_BUCKET_KEY, dayWindowStart(now), costRub);
}
