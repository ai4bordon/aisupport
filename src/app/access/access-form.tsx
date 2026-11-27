"use client";

import { useState, type FormEvent } from "react";

/**
 * Форма ввода кода доступа к стенду.
 *
 * Форма отправляет JSON через `fetch`: маршрут `/api/access` принимает и
 * JSON, и form-urlencoded, но страница и маршрут не должны расходиться в
 * формате (BUGSAUDIT-2026-11-27.md, A2). Cookie `support_access` выдаётся
 * сервером в ответе `Set-Cookie` и браузер кладёт её сам.
 *
 * Код доступа в разметку не попадает: он живёт только в поле ввода и
 * уходит в теле запроса.
 */
export function AccessForm() {
  const [status, setStatus] = useState<"idle" | "pending" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = form.elements.namedItem("code");
    const code = field instanceof HTMLInputElement ? field.value : "";
    if (code.length === 0) {
      return;
    }

    setStatus("pending");
    setMessage("");

    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (response.ok) {
        setStatus("ok");
        setMessage("Доступ выдан. Открываю экран демо…");
        form.reset();
        // Переход на экран демо: ждать, пока клиент сам нажмёт ссылку,
        // не нужно — после входа кода человек пришёл именно за стендом.
        window.location.assign("/start");
        return;
      }

      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setStatus("error");
      setMessage(body?.error?.message ?? "Код доступа не принят");
    } catch {
      setStatus("error");
      setMessage("Не удалось связаться с сервером, попробуйте снова");
    }
  }

  return (
    <>
      <form className="sl-access__form" onSubmit={submit}>
        <label className="sl-access__label" htmlFor="sl-access-code">
          Код доступа
        </label>
        <input
          className="sl-access__input"
          id="sl-access-code"
          name="code"
          type="password"
          autoComplete="off"
          required
        />
        <button className="sl-access__button" type="submit" disabled={status === "pending"}>
          {status === "pending" ? "Проверяем…" : "Войти"}
        </button>
      </form>

      <p
        className={`sl-access__note sl-access__note--${status}`}
        role="status"
        aria-live="polite"
      >
        {status === "idle"
          ? "Если код не принят, обновите страницу и попробуйте снова. Лимиты стенда общие для всех посетителей и не обнуляются при повторном входе."
          : message}
      </p>
    </>
  );
}
