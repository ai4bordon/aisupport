import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccessPage, { metadata } from "@/app/access/page";
import { POST } from "@/app/api/access/route";
import {
  checkManagerAccess,
  readAccessSession,
  readManagerSession,
  signAccessSession,
  verifyAccessCode,
  verifyManagerCode,
  type AccessSession,
} from "@/modules/access";

const TEST_CODE = "demo-test-code-11";
const TEST_SECRET = "demo-test-session-secret-11";
const COOKIE_NAME = "support_access";
const MANAGER_COOKIE_NAME = "support_manager";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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

describe("код доступа и подписанная cookie", () => {
  beforeEach(() => {
    process.env.ACCESS_CODE = TEST_CODE;
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("не принимает запрос без cookie доступа", () => {
    expect(readAccessSession(undefined)).toBeNull();
    expect(readAccessSession("")).toBeNull();
    expect(readAccessSession("other_cookie=1")).toBeNull();
    expect(readAccessSession(`${COOKIE_NAME}=broken.value`)).toBeNull();
  });

  it("отклоняет неверный код и не выдаёт cookie", async () => {
    const response = await postCode("wrong-code");

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();

    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain(TEST_CODE);
  });

  it("не выдаёт cookie, если код доступа не задан в окружении", async () => {
    delete process.env.ACCESS_CODE;

    const response = await postCode(TEST_CODE);

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await verifyAccessCode(TEST_CODE)).toBeNull();
  });

  it("выдаёт подписанную cookie для верного кода", async () => {
    const response = await postCode(TEST_CODE);

    expect(response.status).toBe(200);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    const body = await response.json();
    expect(typeof body.session_id).toBe("string");
    expect(typeof body.expires_at).toBe("string");

    const value = cookieValue(setCookie as string);
    expect(value).not.toContain(TEST_CODE);
    expect(value).not.toContain(sha256Hex(TEST_CODE));

    const session = readAccessSession(`${COOKIE_NAME}=${value}`);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(body.session_id);
    expect(session?.codeDigest).not.toBe(TEST_CODE);
    expect(session?.codeDigest).not.toBe(sha256Hex(TEST_CODE));
    expect(session?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("не пишет код и его хеш в журнал и в ответ", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const denied = await postCode("wrong-code");
    const allowed = await postCode(TEST_CODE);

    const calls = [logSpy, warnSpy, errorSpy, infoSpy].flatMap((spy) => spy.mock.calls);
    const written = calls.map((args) => args.map((arg) => String(arg)).join(" ")).join("\n");
    expect(written).not.toContain(TEST_CODE);
    expect(written).not.toContain(sha256Hex(TEST_CODE));

    for (const response of [denied, allowed]) {
      const text = `${JSON.stringify(await response.clone().json())}${response.headers.get("set-cookie") ?? ""}`;
      expect(text).not.toContain(TEST_CODE);
      expect(text).not.toContain(sha256Hex(TEST_CODE));
    }
  });

  it("инвалидирует ранее выданную cookie после смены кода", async () => {
    const response = await postCode(TEST_CODE);
    const value = cookieValue(response.headers.get("set-cookie") as string);

    expect(readAccessSession(`${COOKIE_NAME}=${value}`)).not.toBeNull();

    process.env.ACCESS_CODE = "another-code-11";

    expect(readAccessSession(`${COOKIE_NAME}=${value}`)).toBeNull();
  });

  it("инвалидирует cookie при смене секрета подписи", async () => {
    const response = await postCode(TEST_CODE);
    const value = cookieValue(response.headers.get("set-cookie") as string);

    process.env.SESSION_SECRET = "another-secret-11";

    expect(readAccessSession(`${COOKIE_NAME}=${value}`)).toBeNull();
  });

  it("не принимает просроченную сессию", async () => {
    const issued = await verifyAccessCode(TEST_CODE);
    expect(issued).not.toBeNull();

    const value = signAccessSession({ ...(issued as NonNullable<typeof issued>), expiresAt: Date.now() - 1000 });

    expect(readAccessSession(`${COOKIE_NAME}=${value}`)).toBeNull();
  });

  it("не пускает в кабинет менеджера без кода менеджера", async () => {
    process.env.MANAGER_CODE = "manager-code-11";

    expect(await verifyManagerCode("not-the-manager-code")).toBeNull();

    const session = await verifyManagerCode("manager-code-11");
    expect(session).not.toBeNull();

    const managerCookie = `${MANAGER_COOKIE_NAME}=${signAccessSession(
      session as AccessSession,
    )}`;
    expect(readManagerSession(managerCookie)).not.toBeNull();

    const standSession = await verifyAccessCode(TEST_CODE);
    expect(
      readManagerSession(`${COOKIE_NAME}=${signAccessSession(standSession as AccessSession)}`),
    ).toBeNull();

    const decision = await checkManagerAccess({ cookieHeader: managerCookie });
    expect(decision.allowed).toBe(true);
  });

  it("отзывает код менеджера при его смене", async () => {
    process.env.MANAGER_CODE = "manager-code-11";
    const session = await verifyManagerCode("manager-code-11");
    const managerCookie = `${MANAGER_COOKIE_NAME}=${signAccessSession(
      session as AccessSession,
    )}`;

    expect(readManagerSession(managerCookie)).not.toBeNull();

    process.env.MANAGER_CODE = "another-manager-code-11";

    expect(readManagerSession(managerCookie)).toBeNull();
  });

  it("не помещает код в разметку страницы доступа", () => {
    const { container } = render(createElement(AccessPage));

    expect(container.innerHTML).not.toContain(TEST_CODE);
    expect(container.querySelector("input[type=password]")).not.toBeNull();
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("оформляет страницу доступа по фирменному стилю R26", async () => {
    const { container } = render(createElement(AccessPage));
    const html = container.innerHTML;
    const css = await readFile(
      resolve(process.cwd(), "src/app/access/styles.css"),
      "utf8",
    );

    expect(css).toContain("var(--sl-font-sans)");
    expect(css).toContain("var(--sl-logo-guard)");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(container.querySelector("img")).not.toBeNull();
    expect(String(metadata.title)).toContain("Софтлайн");
  });

  it("заголовок страницы и favicon оформлены по R26", async () => {
    expect(String(metadata.title)).toContain("Софтлайн Решения");

    // Favicon — утверждённый файл логотипа без изменений: побайтово.
    const icon = await readFile(resolve(process.cwd(), "src/app/access/icon.png"));
    const approved = await readFile(
      resolve(
        process.cwd(),
        "../../docs/лого софтлайн/Софтлайн-решения+SOFL_Logo_rgb (2).png",
      ),
    );
    expect(icon.equals(approved)).toBe(true);
  });

  it("использует web-палитру и стек шрифтов из общих токенов", async () => {
    const tokens = await readFile(
      resolve(process.cwd(), "src/app/styles/tokens.css"),
      "utf8",
    );

    // Проверяются вычисленные значения переменных, а не только их наличие.
    expect(tokens).toMatch(/--sl-accent:\s*#a50f2d/i);
    expect(tokens).toMatch(/--sl-accent-hover:\s*#d20b33/i);
    expect(tokens).toMatch(/--sl-bg:\s*#f0f2f6/i);
    expect(tokens).toMatch(/--sl-text:\s*#212424/i);
    expect(tokens).toMatch(/--sl-text-secondary:\s*#40454e/i);
    expect(tokens).toMatch(/--sl-divider:\s*#d2dce5/i);
    expect(tokens).toMatch(/--sl-font-sans:\s*"Montserrat",\s*"Segoe UI"/i);
  });

  it("держит охранное поле логотипа не меньше его высоты", async () => {
    const css = await readFile(
      resolve(process.cwd(), "src/app/access/styles.css"),
      "utf8",
    );

    const logoHeight = /--sl-access-logo-height:\s*(\d+)px/.exec(css)?.[1];
    expect(logoHeight).toBeDefined();

    const guard = /max\(var\(--sl-logo-guard\),\s*var\(--sl-access-logo-height\)\)/.test(css);
    expect(guard).toBe(true);

    // Охранное поле общего токена — 24 px; логотип на странице выше.
    const tokens = await readFile(
      resolve(process.cwd(), "src/app/styles/tokens.css"),
      "utf8",
    );
    const tokenGuard = Number.parseInt(
      /--sl-logo-guard:\s*(\d+)px/.exec(tokens)?.[1] ?? "0",
      10,
    );
    expect(tokenGuard).toBeGreaterThan(0);
    expect(Number.parseInt(logoHeight as string, 10)).toBeGreaterThanOrEqual(tokenGuard);
  });
});
