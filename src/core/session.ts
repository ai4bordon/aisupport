import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Подпись идентификатора диалога в cookie.
 *
 * Cookie содержит только идентификатор диалога: имя, телефон, email, IP и
 * другие данные в неё не попадают (docs/api-contract.md §4). Подпись —
 * HMAC-SHA256 от секрета `SESSION_SECRET`; сравнение constant-time.
 *
 * Если секрет не задан, подпись невозможно проверить: диалог считается
 * новым. Это безопасное поведение — неподписанную cookie принять нельзя.
 */

export const CONVERSATION_COOKIE_NAME = "support_conversation";

function sessionSecret(): string | null {
  return process.env.SESSION_SECRET ?? null;
}

export function signConversationId(id: string): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error("SESSION_SECRET is not set");
  }
  return createHmac("sha256", secret).update(id).digest("base64url");
}

/** Формат cookie: `<id>.<подпись>`. */
export function buildCookieValue(id: string): string {
  return `${id}.${signConversationId(id)}`;
}

function verifySignature(id: string, signature: string): boolean {
  const secret = sessionSecret();
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(id).digest("base64url");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const givenBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== givenBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, givenBuffer);
}

/**
 * Чтение идентификатора диалога из заголовка `Cookie`.
 *
 * Возвращает `null`, если cookie нет, подпись неверна или секрет не задан.
 */
export function readConversationId(
  cookieHeader: string | undefined,
): { id: string } | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== CONVERSATION_COOKIE_NAME) continue;

    const value = decodeURIComponent(part.slice(separator + 1).trim());
    const dot = value.lastIndexOf(".");
    if (dot <= 0) return null;

    const id = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    if (!id || !signature) return null;
    if (!verifySignature(id, signature)) return null;
    return { id };
  }

  return null;
}

/** Заголовок `Set-Cookie` для нового диалога. */
export function buildSetCookie(id: string): string {
  return `${CONVERSATION_COOKIE_NAME}=${encodeURIComponent(buildCookieValue(id))}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}
