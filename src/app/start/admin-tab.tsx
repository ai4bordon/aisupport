"use client";

import { useEffect, useState } from "react";

/**
 * Вкладка «Админка»: кабинет менеджера.
 *
 * Кабинет живёт по отдельному коду менеджера и по отдельной cookie
 * `support_manager`: клиентский код стенда в кабинет не пускает, а код
 * менеджера в клиентскую cookie не попадает.
 *
 * Если кабинет ещё не готов, показывается честное состояние со ссылкой —
 * без имитации работы.
 */

/** Что показано в кадре кабинета. */
type ManagerState = "checking" | "ready" | "missing" | "forbidden" | "unavailable";

export function AdminTab() {
  const [state, setState] = useState<ManagerState>("checking");

  useEffect(() => {
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const response = await fetch("/manager", { method: "GET", redirect: "manual" });
        if (cancelled) return;
        if (response.status === 401 || response.status === 403) {
          setState("forbidden");
          return;
        }
        if (response.status === 404) {
          setState("missing");
          return;
        }
        setState("ready");
      } catch {
        if (!cancelled) setState("unavailable");
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return (
      <section className="sl-start__card">
        <div className="sl-start__row sl-start__row-between">
          <h2 className="sl-start__card-title">Кабинет менеджера</h2>
          <a
            className="sl-start__link"
            href="/manager"
            target="_blank"
            rel="noreferrer"
          >
            Открыть кабинет отдельно
          </a>
        </div>
        <p className="sl-start__state" role="status">
          Проверяем готовность кабинета…
        </p>
      </section>
    );
  }

  if (state === "missing") {
    return (
      <section className="sl-start__card">
        <div className="sl-start__row sl-start__row-between">
          <h2 className="sl-start__card-title">Кабинет менеджера</h2>
          <a
            className="sl-start__link"
            href="/manager"
            target="_blank"
            rel="noreferrer"
          >
            Открыть кабинет отдельно
          </a>
        </div>
        <div className="sl-start__state" role="status">
          <p className="sl-start__state-title">Кабинет в разработке</p>
          <p>
            Страница кабинета ещё не собрана: маршрут <code>/manager</code> на
            стенде не отвечает. Как только кабинет будет готов, здесь
            появится он.
          </p>
        </div>
      </section>
    );
  }

  if (state === "unavailable") {
    return (
      <section className="sl-start__card">
        <div className="sl-start__row sl-start__row-between">
          <h2 className="sl-start__card-title">Кабинет менеджера</h2>
          <a
            className="sl-start__link"
            href="/manager"
            target="_blank"
            rel="noreferrer"
          >
            Открыть кабинет отдельно
          </a>
        </div>
        <div className="sl-start__state sl-start__state--error" role="alert">
          <p className="sl-start__state-title">Кабинет временно недоступен</p>
          <p>Сервер не ответил на проверку готовности. Попробуйте позже.</p>
        </div>
      </section>
    );
  }

  return <ManagerFrame state={state} />;
}

/**
 * Кадр кабинета: запрос кода менеджера и сам кабинет.
 *
 * Код проверяется через `/api/access` с флагом `manager` — сервер выдаёт
 * отдельную cookie `support_manager`. Пока кода нет, кабинет не грузится, и
 * вместо него видна форма входа.
 */
function ManagerFrame({ state }: { state: ManagerState }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [granted, setGranted] = useState(state === "ready");

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = code.trim();
    if (value.length === 0 || pending) return;

    setPending(true);
    setError(null);
    try {
      // Код один на весь стенд: он открывает и чат, и кабинет.
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: value }),
      });

      if (response.ok) {
        setGranted(true);
        setCode("");
        return;
      }

      if (response.status === 401) {
        setError("Код не принят. Проверьте код и попробуйте снова.");
      } else {
        setError("Не удалось проверить код: сервер ответил кодом " + response.status + ".");
      }
    } catch {
      setError("Не удалось связаться с сервером. Попробуйте позже.");
    } finally {
      setPending(false);
    }
  }

  if (!granted) {
    return (
      <section className="sl-start__card">
        <div className="sl-start__row sl-start__row-between">
          <h2 className="sl-start__card-title">Кабинет менеджера</h2>
          <a
            className="sl-start__link"
            href="/manager"
            target="_blank"
            rel="noreferrer"
          >
            Открыть кабинет отдельно
          </a>
        </div>
        <p className="sl-start__card-lead">
          Кабинет открывается по отдельному коду менеджера. Он не тот же, что
          код стенда, и выдаёт отдельную cookie — клиентский доступ в кабинет
          не проходит.
        </p>
        <form className="sl-start__form" onSubmit={(event) => void submit(event)}>
          <div className="sl-start__field">
            <label className="sl-start__label" htmlFor="sl-start-manager-code">
              Код менеджера
            </label>
            <input
              className="sl-start__input"
              id="sl-start-manager-code"
              name="code"
              type="password"
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </div>
          <button className="sl-start__button" type="submit" disabled={pending}>
            {pending ? "Проверяем…" : "Войти в кабинет"}
          </button>
        </form>
        {error && (
          <p className="sl-start__note" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="sl-start__card">
      <div className="sl-start__row sl-start__row-between">
        <h2 className="sl-start__card-title">Кабинет менеджера</h2>
        <a
          className="sl-start__link"
          href="/manager"
          target="_blank"
          rel="noreferrer"
        >
          Открыть кабинет отдельно
        </a>
      </div>
      <p className="sl-start__card-lead">
        Очередь обращений, обещания, база знаний и настройки агента.
      </p>
      <iframe
        className="sl-start__iframe"
        src="/manager"
        title="Кабинет менеджера поддержки"
      />
    </section>
  );
}
