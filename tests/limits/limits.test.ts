import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_EXHAUSTED_MESSAGE,
  checkDailyDialogs,
  checkModelBudget,
  checkRateLimit,
  recordModelSpend,
} from "@/modules/limits";
import { verifyAccessCode } from "@/modules/access";
import { ensureDatabase, resetCounters } from "./helpers";

const IP = "203.0.113.7";
const TEST_CODE = "demo-test-code-11";
const TEST_SECRET = "demo-test-session-secret-11";
/** Свой арендатор у каждого тестового файла: счётчики не мешают друг другу. */
const TENANT_SLUG = "demo-tenant-limits-11";

describe("лимиты запросов, диалогов и бюджета", () => {
  beforeAll(async () => {
    await ensureDatabase(TENANT_SLUG);
  });

  beforeEach(async () => {
    process.env.ACCESS_CODE = TEST_CODE;
    process.env.SESSION_SECRET = TEST_SECRET;
    await resetCounters();
  });

  it("пропускает 10 запросов в минуту с одного IP", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const decision = await checkRateLimit(IP);
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe("ok");
      expect(decision.limit).toBe(10);
    }
  });

  it("отклоняет 11-й запрос в минуту с одного IP", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await checkRateLimit(IP);
    }

    const decision = await checkRateLimit(IP);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("rate_limited");
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("не отпускает больше лимита при конкурентных запросах с одного IP", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 15 }, () => checkRateLimit(IP)),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(5);
  });

  it("считает запросы по IP: другой адрес не расходует квоту первого", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await checkRateLimit(IP);
    }

    expect((await checkRateLimit(IP)).allowed).toBe(false);
    expect((await checkRateLimit("198.51.100.4")).allowed).toBe(true);
  });

  it("разрешает 50 диалогов за сутки и не запускает 51-й", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const decision = await checkDailyDialogs();
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe("ok");
      expect(decision.limit).toBe(50);
    }

    const decision = await checkDailyDialogs();

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("daily_limit");
    expect(decision.limit).toBe(50);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("не обнуляет счётчик диалогов при повторном вводе кода", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await checkDailyDialogs();
    }

    // Повторный ввод кода в новой вкладке выдаёт новую сессию, но квоту
    // диалогов не создаёт: счётчик один на стенд.
    const session = await verifyAccessCode(TEST_CODE);
    expect(session).not.toBeNull();

    expect((await checkDailyDialogs()).allowed).toBe(false);
  });

  it("не обнуляет суточный счётчик при перезапуске процесса", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await checkDailyDialogs();
    }

    vi.resetModules();
    const restarted = await import("@/modules/limits");

    const decision = await restarted.checkDailyDialogs();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("daily_limit");
  });

  it("запрещает новые вызовы модели при исчерпанном часовом бюджете", async () => {
    await recordModelSpend(30);

    const decision = await checkModelBudget();

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("budget_exhausted");
    expect(decision.spentHour).toBe(30);
    expect(decision.limitHour).toBe(30);
    expect(decision.limitDay).toBe(300);
  });

  it("даёт понятное сообщение об исчерпанном лимите вместо ошибки сервера", async () => {
    await recordModelSpend(30);

    const decision = await checkModelBudget();

    expect(decision.allowed).toBe(false);
    expect(BUDGET_EXHAUSTED_MESSAGE).toContain("Лимит демо исчерпан");
    expect(BUDGET_EXHAUSTED_MESSAGE).toContain("попробуйте позже");
  });

  it("разрешает вызовы модели, пока часовой бюджет не исчерпан", async () => {
    await recordModelSpend(29.9);

    const decision = await checkModelBudget();

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ok");
    expect(decision.spentHour).toBe(29.9);
  });

  it("не списывает бюджет повторно при ошибке провайдера 429 или 402", async () => {
    await recordModelSpend(5);

    // Неуспешный вызов стоит ноль: провайдер не сообщил о списании.
    // Повторная обработка ответа провайдера добавляет ноль ещё раз.
    await recordModelSpend(0);
    await recordModelSpend(0);

    const decision = await checkModelBudget();

    expect(decision.spentHour).toBe(5);
    expect(decision.spentDay).toBe(5);
  });

  it("накапливает расход по часу и по суткам", async () => {
    await recordModelSpend(10);
    await recordModelSpend(7.5);

    const decision = await checkModelBudget();

    expect(decision.spentHour).toBe(17.5);
    expect(decision.spentDay).toBe(17.5);
  });

  it("не теряет расход при конкурентных вызовах модели", async () => {
    await Promise.all([
      recordModelSpend(10),
      recordModelSpend(10),
      recordModelSpend(10),
    ]);

    const decision = await checkModelBudget();

    expect(decision.spentHour).toBe(30);
    expect(decision.spentDay).toBe(30);
    expect(decision.allowed).toBe(false);
  });

  it("разрешает запрос при лимитах, заданных окружением", async () => {
    const previous = process.env.REQUESTS_PER_MINUTE;
    process.env.REQUESTS_PER_MINUTE = "2";

    try {
      expect((await checkRateLimit(IP)).allowed).toBe(true);
      expect((await checkRateLimit(IP)).allowed).toBe(true);

      const third = await checkRateLimit(IP);
      expect(third.allowed).toBe(false);
      expect(third.limit).toBe(2);
    } finally {
      if (previous === undefined) {
        delete process.env.REQUESTS_PER_MINUTE;
      } else {
        process.env.REQUESTS_PER_MINUTE = previous;
      }
    }
  });

  it("уважает суточный лимит диалогов из окружения", async () => {
    const previous = process.env.DAILY_DIALOG_LIMIT;
    process.env.DAILY_DIALOG_LIMIT = "2";

    try {
      expect((await checkDailyDialogs()).allowed).toBe(true);
      expect((await checkDailyDialogs()).allowed).toBe(true);

      const third = await checkDailyDialogs();
      expect(third.allowed).toBe(false);
      expect(third.limit).toBe(2);
    } finally {
      if (previous === undefined) {
        delete process.env.DAILY_DIALOG_LIMIT;
      } else {
        process.env.DAILY_DIALOG_LIMIT = previous;
      }
    }
  });
});
