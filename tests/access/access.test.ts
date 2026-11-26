import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccessPage, { metadata } from "@/app/access/page";
import { POST } from "@/app/api/access/route";
import { readAccessSession, signAccessSession, verifyAccessCode } from "@/modules/access";

const TEST_CODE = "demo-test-code-11";
const TEST_SECRET = "demo-test-session-secret-11";
const COOKIE_NAME = "support_access";

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
});
