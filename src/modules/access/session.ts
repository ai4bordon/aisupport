import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type AccessSession = {
  sessionId: string;
  codeDigest: string;
  expiresAt: number;
};

/** Имя cookie доступа — заморожено контрактом `docs/api-contract.md` §11.1. */
export const ACCESS_COOKIE_NAME = "support_access";

/** Время жизни сессии по умолчанию; владелец может задать его через окружение. */
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Отпечаток кода — HMAC-SHA256 от секрета подписи и самого кода.
 * Отпечаток нельзя перебрать офлайн без секрета, поэтому он не раскрывает
 * код даже при утечке cookie.
 */
export function digestAccessCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

export function sessionTtlSeconds(): number {
  const raw = process.env.ACCESS_SESSION_TTL_SECONDS;
  if (!raw) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_SECONDS;
}

/**
 * Сравнение без утечки времени: сравниваются хеши одинаковой длины,
 * а не сами строки.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

export function currentAccessCode(): string | null {
  const code = process.env.ACCESS_CODE;
  return code && code.length > 0 ? code : null;
}

export function currentSessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

/**
 * Подпись HMAC-SHA256. В подписанные данные входят идентификатор сессии,
 * срок действия и отпечаток кода, поэтому смена кода или секрета
 * инвалидирует ранее выданную cookie. В саму cookie ни код, ни его
 * отпечаток не попадают.
 */
function computeSignature(
  sessionId: string,
  expiresAt: number,
  codeDigest: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${sessionId}.${expiresAt}.${codeDigest}`, "utf8")
    .digest("base64url");
}

export function signAccessSession(session: AccessSession): string {
  const secret = currentSessionSecret();
  if (!secret) {
    throw new Error("SESSION_SECRET не задан в окружении");
  }
  const payload = Buffer.from(`${session.sessionId}.${session.expiresAt}`, "utf8").toString("base64url");
  const signature = computeSignature(session.sessionId, session.expiresAt, session.codeDigest, secret);
  return `${payload}.${signature}`;
}

export function readCookieValue(cookieHeader: string | undefined | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function readAccessSession(cookieHeader: string | undefined | null): AccessSession | null {
  const code = currentAccessCode();
  const secret = currentSessionSecret();
  if (!code || !secret) {
    return null;
  }

  const raw = readCookieValue(cookieHeader, ACCESS_COOKIE_NAME);
  if (!raw) {
    return null;
  }

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const fieldSeparator = decoded.lastIndexOf(".");
  if (fieldSeparator <= 0) {
    return null;
  }
  const sessionId = decoded.slice(0, fieldSeparator);
  const expiresAt = Number(decoded.slice(fieldSeparator + 1));
  if (!Number.isFinite(expiresAt)) {
    return null;
  }

  const codeDigest = digestAccessCode(code, secret);
  const expected = computeSignature(sessionId, expiresAt, codeDigest, secret);
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return null;
  }
  if (expiresAt <= Date.now()) {
    return null;
  }

  return { sessionId, codeDigest, expiresAt };
}

export async function verifyAccessCode(code: string): Promise<AccessSession | null> {
  const expected = currentAccessCode();
  const secret = currentSessionSecret();
  if (!expected || !secret || typeof code !== "string" || code.length === 0) {
    return null;
  }
  if (!constantTimeEquals(code, expected)) {
    return null;
  }
  return {
    sessionId: randomUUID(),
    codeDigest: digestAccessCode(expected, secret),
    expiresAt: Date.now() + sessionTtlSeconds() * 1000,
  };
}

export function buildAccessCookie(session: AccessSession): string {
  const value = signAccessSession(session);
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  return [
    `${ACCESS_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}
