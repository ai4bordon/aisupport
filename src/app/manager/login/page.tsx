"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ManagerButton } from "../components/managerButton";
import { ManagerLoading } from "../components/managerLoading";

/**
 * Вход в кабинет менеджера.
 *
 * Код один на весь стенд — `ACCESS_CODE`: он открывает и чат, и кабинет
 * (решение владельца от 28.11.2026). Раздельные коды заводим позже, когда
 * стенд возьмёт заказчик.
 *
 * Код не показывается в разметке и не пишется в журнал: он уходит
 * JSON-телом `{ code }` на `/api/access`, где сверяется на сервере. В
 * браузере остаётся только подписанная cookie сессии.
 *
 * Состояния страницы явные: загрузка (проверка кода), ошибка (код не принят
 * или сервер недоступен) и переход в кабинет после успеха.
 */
export default function ManagerLoginPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }

    const value = code.trim();
    if (value.length === 0) {
      setError("Введите код доступа.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      // Код один на весь стенд: он открывает и чат, и кабинет.
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: value }),
      });

      if (!response.ok) {
        // Код не принят — поле очищается, чтобы секрет не оставался в DOM.
        setCode("");
        setError(await readError(response));
        return;
      }

      // Код проверён сервером; в браузере остаётся только подписанная cookie.
      setCode("");
      setDone(true);
      router.push("/manager");
    } catch {
      setError("Сервер не ответил. Проверьте соединение и попробуйте снова.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sl-m-page sl-m-page--login">
      <div className="sl-m-login">
        <h1 className="sl-m-page__title">Вход в кабинет менеджера</h1>
        <p className="sl-m-page__lead">
          Код один на весь стенд: он открывает и чат, и кабинет. Код
          проверяется на сервере и не сохраняется в браузере: выдаётся
          подписанная cookie сессии.
        </p>

        <form className="sl-m-login__form" onSubmit={submit} noValidate>
          <label className="sl-m-login__label" htmlFor="sl-m-manager-code">
            Код доступа
          </label>
          <input
            className="sl-m-login__input"
            id="sl-m-manager-code"
            name="code"
            type="password"
            autoComplete="off"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={pending}
          />

          {pending ? <ManagerLoading label="Проверяем код доступа" /> : null}

          {error ? (
            <p className="sl-m-login__error" role="alert">
              {error}
            </p>
          ) : null}

          {done && !pending ? (
            <p className="sl-m-login__done" role="status">
              Код принят. Открываем кабинет.
            </p>
          ) : null}

          <ManagerButton variant="primary" type="submit" disabled={pending}>
            Войти в кабинет
          </ManagerButton>
        </form>

        <p className="sl-m-login__note">
          Код клиентского стенда кабинет менеджера не открывает: у кабинета
          своя cookie сессии.
        </p>
      </div>
    </div>
  );
}

/**
 * Текст ошибки из тела ответа `/api/access`.
 *
 * Берётся только поле `error.message` контракта; сам код в ответе не
 * возвращается и в сообщение не попадает.
 */
async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // Тело ответа не разобралось — сообщаем общий текст.
  }
  return "Код не принят. Проверьте код доступа и попробуйте снова.";
}
