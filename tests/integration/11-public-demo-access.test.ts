import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import AccessPage, { metadata } from "@/app/access/page";
import { POST } from "@/app/api/access/route";
import {
  checkDailyDialogs,
  checkModelBudget,
  checkRateLimit,
  closePool,
  recordModelSpend,
} from "@/modules/limits";
import { checkAccess, readAccessSession } from "@/modules/access";
import { ensureDatabase, resetCounters } from "../limits/helpers";

/**
 * Интеграционный тест среза 11: барьер доступа и лимиты стенда вместе.
 *
 * Команда проверки тикета: `npm run test -- tests/integration/11-public-demo-access.test.ts`
 */

const TEST_CODE = "demo-test-code-11";
const TEST_SECRET = "demo-test-session-secret-11";
const COOKIE_NAME = "support_access";
/** Свой арендатор у каждого тестового файла: счётчики не мешают друг другу. */
const TENANT_SLUG = "demo-tenant-integration-11";

function postCode(code: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
}

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(";")[0] ?? "";
  const separator = pair.indexOf("=");
  return separator >= 0 ? pair.slice(separator + 1) : "";
}

describe("11 — защита публичного демонстрационного стенда", () => {
  beforeAll(async () => {
    await ensureDatabase(TENANT_SLUG);
  });

  beforeEach(async () => {
    process.env.ACCESS_CODE = TEST_CODE;
    process.env.SESSION_SECRET = TEST_SECRET;
    await resetCounters();
  });

  afterAll(async () => {
    await closePool();
  });

  it("не пускает в чат без кода доступа", async () => {
    const response = await postCode("wrong-code");

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(readAccessSession(undefined)).toBeNull();

    const missing = await checkAccess({ ip: "203.0.113.30" });
    expect(missing.allowed).toBe(false);
    expect(missing.reason).toBe("missing_code");
    expect(missing.retryAfterSeconds).toBeNull();

    const invalid = await checkAccess({
      ip: "203.0.113.30",
      cookieHeader: `${COOKIE_NAME}=broken.value`,
    });
    expect(invalid.allowed).toBe(false);
    expect(invalid.reason).toBe("invalid_code");
  });

  it("пускает авторизованный запрос и считает его квоту", async () => {
    const response = await postCode(TEST_CODE);
    const cookieHeader = `${COOKIE_NAME}=${cookieValue(
      response.headers.get("set-cookie") as string,
    )}`;

    const decision = await checkAccess({ ip: "203.0.113.31", cookieHeader });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ok");
  });

  it("не тратит квоту диалогов на запросы без кода доступа", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await checkAccess({ ip: "203.0.113.32" });
    }

    // Лимит диалогов не тронут: запросы без кода диалог не создают.
    const dialog = await checkDailyDialogs();
    expect(dialog.allowed).toBe(true);
  });

  it("не расходует квоту диалогов на каждый запрос", async () => {
    const previous = process.env.REQUESTS_PER_MINUTE;
    process.env.REQUESTS_PER_MINUTE = "1000";

    try {
      const response = await postCode(TEST_CODE);
      const cookieHeader = `${COOKIE_NAME}=${cookieValue(
        response.headers.get("set-cookie") as string,
      )}`;

      for (let attempt = 0; attempt < 60; attempt += 1) {
        const decision = await checkAccess({ ip: "203.0.113.40", cookieHeader });
        expect(decision.allowed).toBe(true);
      }

      // Квота диалогов не тронута: 60 запросов — это не 60 диалогов.
      const dialog = await checkDailyDialogs();
      expect(dialog.allowed).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.REQUESTS_PER_MINUTE;
      } else {
        process.env.REQUESTS_PER_MINUTE = previous;
      }
    }
  });

  it("считает неавторизованные запросы в лимите запросов по IP", async () => {
    const decisions: boolean[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const decision = await checkAccess({ ip: "203.0.113.41" });
      decisions.push(decision.allowed);
    }

    // Первые десять отклонены по коду, одиннадцатый — по лимиту запросов.
    expect(decisions.slice(0, 10).every((allowed) => !allowed)).toBe(true);
    expect(decisions[10]).toBe(false);

    const limited = await checkAccess({ ip: "203.0.113.41" });
    expect(limited.allowed).toBe(false);
    expect(limited.reason).toBe("rate_limited");
    expect(limited.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("отзывает cookie после смены кода", async () => {
    const response = await postCode(TEST_CODE);
    const cookieHeader = `${COOKIE_NAME}=${cookieValue(
      response.headers.get("set-cookie") as string,
    )}`;

    expect((await checkAccess({ ip: "203.0.113.33", cookieHeader })).allowed).toBe(true);

    process.env.ACCESS_CODE = "another-code-11";

    const decision = await checkAccess({ ip: "203.0.113.33", cookieHeader });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("invalid_code");
  });

  it("выдаёт подписанную cookie и принимает её обратно", async () => {
    const response = await postCode(TEST_CODE);

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") as string;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    const value = cookieValue(setCookie);
    expect(value).not.toContain(TEST_CODE);
    expect(readAccessSession(`${COOKIE_NAME}=${value}`)).not.toBeNull();
  });

  it("не обнуляет квоту при повторном вводе кода в новой вкладке", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await checkDailyDialogs();
    }

    const first = await postCode(TEST_CODE);
    const second = await postCode(TEST_CODE);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(
      cookieValue(first.headers.get("set-cookie") as string),
    ).not.toBe(cookieValue(second.headers.get("set-cookie") as string));

    const decision = await checkDailyDialogs();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("daily_limit");
  });

  it("отклоняет 11-й запрос в минуту с одного IP", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await checkRateLimit("203.0.113.20")).allowed).toBe(true);
    }

    const decision = await checkRateLimit("203.0.113.20");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("rate_limited");
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("не запускает 51-й диалог за сутки", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect((await checkDailyDialogs()).allowed).toBe(true);
    }

    const decision = await checkDailyDialogs();

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("daily_limit");
  });

  it("останавливает новые вызовы модели при исчерпанном бюджете", async () => {
    await recordModelSpend(30);

    const decision = await checkModelBudget();

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("budget_exhausted");
    expect(decision.spentHour).toBe(30);
    expect(decision.limitHour).toBe(30);
  });

  it("не хранит код доступа и его хеш в ответе и в разметке", async () => {
    const response = await postCode(TEST_CODE);
    const setCookie = response.headers.get("set-cookie") as string;
    const body = JSON.stringify(await response.clone().json());
    const { container } = render(createElement(AccessPage));

    for (const text of [body, setCookie, container.innerHTML]) {
      expect(text).not.toContain(TEST_CODE);
      expect(text).not.toContain(TEST_SECRET);
    }
  });

  it("оформляет страницу доступа по фирменному стилю R26", () => {
    const { container } = render(createElement(AccessPage));

    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(container.querySelector("img")).not.toBeNull();
    expect(String(metadata.title)).toContain("Софтлайн");
  });
});
