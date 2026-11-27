/**
 * Идентификатор клиента для счётчика лимита запросов.
 *
 * Лимит 10 запросов в минуту считается по адресу клиента, поэтому адрес
 * нельзя брать из заголовка, который подставляет сам клиент: иначе любой
 * обходит лимит, подставив новый `x-forwarded-for` в каждый запрос.
 *
 * Заголовок `x-forwarded-for` — это адрес, записанный обратным прокси.
 * Доверять ему можно только когда стенд действительно стоит за прокси, и
 * владелец это подтвердил переменной `ALLOW_PROXY_HEADERS=1`. Без флага
 * заголовок игнорируется полностью.
 *
 * Почему без флага не берётся «просто адрес соединения»: в middleware
 * Next.js 16 объекта сокета нет — middleware получает `NextRequestHint`,
 * собранный из заголовков (node_modules/next/dist/server/web/adapter.js).
 * Next подставляет в `x-forwarded-for` адрес соединения, только если клиент
 * этот заголовок не прислал, но отличить подставленный Next заголовок от
 * присланного клиентом в middleware нельзя. Поэтому без подтверждённого
 * прокси счётчик ведётся по подписанной сессии доступа: её нельзя
 * подделать без кода доступа, и подменой заголовка лимит не обходится.
 *
 * За обратным прокси (то есть на публичном стенде) адрес клиента известен
 * точно, и лимит считается по нему, как и обещает контракт §11.2.
 */

import { readAccessSession } from "./session";

/** Имя переменной окружения, которой владелец включает доверие прокси. */
export const ALLOW_PROXY_HEADERS_ENV = "ALLOW_PROXY_HEADERS";

/** Значение переменной, включающее доверие заголовкам прокси. */
export const ALLOW_PROXY_HEADERS_ON = "1";

/**
 * Адрес, когда источник неизвестен.
 *
 * Используется как часть ключа, когда клиент прислал заголовок прокси, а
 * прокси не подтверждён: такие клиенты делят один счётчик.
 */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * Доверие заголовкам прокси включено ли владельцем.
 *
 * Включается только явным значением `1`: опечатка в переменной не должна
 * молча открывать лимит.
 */
export function proxyHeadersAllowed(): boolean {
  return process.env[ALLOW_PROXY_HEADERS_ENV] === ALLOW_PROXY_HEADERS_ON;
}

/**
 * Адрес клиента из цепочки `x-forwarded-for`.
 *
 * Цепочку дописывают прокси по дороге, поэтому адрес исходного клиента —
 * первый в списке, а не последний.
 */
export function firstForwardedAddress(chain: string): string | null {
  for (const part of chain.split(",")) {
    const address = part.trim();
    if (address.length > 0) {
      return address;
    }
  }
  return null;
}

/**
 * Адрес клиента по заголовкам прокси.
 *
 * Без `ALLOW_PROXY_HEADERS=1` заголовки игнорируются полностью: их прислал
 * клиент, доверять им нельзя. С флагом берётся первый адрес цепочки —
 * за прокси это адрес исходного клиента.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  if (!proxyHeadersAllowed()) {
    return UNKNOWN_CLIENT_IP;
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const address = firstForwardedAddress(forwarded);
    if (address !== null) {
      return address;
    }
  }

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && realIp.length > 0) {
    return realIp;
  }

  return UNKNOWN_CLIENT_IP;
}

/**
 * Ключ счётчика лимита запросов для клиента.
 *
 * За обратным прокси — адрес клиента: лимит 10 запросов в минуту на IP,
 * как обещает контракт §11.2.
 *
 * Без подтверждённого прокси — подписанная сессия доступа: подменой
 * заголовка или cookie без кода доступа ключ не меняется, поэтому лимит
 * обойти нельзя. Клиенты без сессии делят один ключ: иначе каждый новый
 * анонимный запрос получал бы свой счётчик.
 */
export function clientBucketKey(input: {
  headers: { get(name: string): string | null };
  cookieHeader: string | null;
}): string {
  if (proxyHeadersAllowed()) {
    return `ip:${clientIp(input.headers)}`;
  }

  const session = readAccessSession(input.cookieHeader);
  if (session) {
    return `session:${session.sessionId}`;
  }

  return "anonymous";
}
