import type { Metadata } from "next";
import { headers } from "next/headers";

import { accessHttpStatus, checkAccess } from "@/modules/access";

import { StartScreen } from "./start-screen";
import "./styles.css";

/**
 * Экран демо `/start` — лицо питча: три вкладки на одном экране.
 *
 * Серверная часть страницы проверяет клиентский код стенда общим барьером
 * `checkAccess`. Мидлваре этот путь не закрывает, а дублировать проверку в
 * двух местах смысла нет, поэтому она живёт здесь.
 *
 * Если кода нет — вместо экрана показывается честное состояние со ссылкой
 * на `/access`: имитировать работу стенда без доступа нельзя.
 */

export const metadata: Metadata = {
  title: "Демонстрация ИИ-агента поддержки — Софтлайн Решения",
  description:
    "Единый экран демонстрации: веб-чат, канал MAX и кабинет менеджера ИИ-агента поддержки.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Первое значение параметра: в URL он может прийти массивом. */
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function StartPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const requestHeaders = await headers();

  const decision = await checkAccess({
    cookieHeader: requestHeaders.get("cookie"),
    ip: requestHeaders.get("x-forwarded-for") ?? "0.0.0.0",
  });

  if (!decision.allowed) {
    return <AccessRequired status={accessHttpStatus(decision)} />;
  }

  const origin = requestHeaders.get("x-forwarded-proto")
    ? `${requestHeaders.get("x-forwarded-proto")}://${requestHeaders.get("host")}`
    : `http://${requestHeaders.get("host") ?? "localhost:3000"}`;

  return (
    <StartScreen initialTab={firstParam(params.tab)} origin={origin} />
  );
}

/**
 * Честное состояние «нет доступа»: экран не открывается без кода стенда.
 *
 * Смысл причины объясняется прямо: почему вход не прошёл и что делать.
 */
function AccessRequired({ status }: { status: number }) {
  const reason =
    status === 429
      ? "Лимит запросов стенда исчерпан. Подождите минуту и попробуйте снова."
      : "Введите код доступа к демонстрационному стенду.";

  return (
    <main className="sl-start">
      <div className="sl-start__main">
        <section className="sl-start__card">
          <h1 className="sl-start__card-title">Нужен код доступа</h1>
          <p className="sl-start__card-lead">{reason}</p>
          <p className="sl-start__note">
            Код проверяется на сервере и хранится только в подписанной cookie
            стенда.
          </p>
          <p className="sl-start__note">
            <a className="sl-start__link" href="/access">
              Войти на стенд (/access)
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
