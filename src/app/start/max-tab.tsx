"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { QrCode } from "./qr-code";
import { BOT_LINK, BOT_USERNAME } from "./max-bot";

/**
 * Вкладка «MAX»: статус бота, ссылка с QR и живая лента сообщений.
 *
 * Лента берётся из `/api/demo/max-feed` — это наша база, а не iframe
 * мессенджера. Обновление идёт раз в три секунды и только пока вкладка
 * активна и документ виден: в фоне запросы не идут.
 */

/** Сообщение ленты в безопасном виде. */
type FeedMessage = {
  text_masked: string;
  role: string;
  created_at: string;
  conversation_id: string;
};

/** Статус канала MAX. */
type FeedStatus = {
  published: boolean;
  worker_listening: boolean;
  marker: number | null;
  last_event_at: string | null;
  shadow_mode: boolean;
};

type FeedBody = {
  bot: { username: string; link: string };
  status: FeedStatus;
  messages: FeedMessage[];
  empty: boolean;
};

/** Интервал опроса ленты. */
const POLL_INTERVAL_MS = 3000;

/** Как вкладка называет роль отправителя. */
const ROLE_NAMES: Record<string, string> = {
  client: "Клиент",
  agent: "Агент",
  manager: "Менеджер",
  system: "Система",
};

/** Время сообщения в понятном виде. */
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function MaxTab() {
  return (
    <>
      <BotCard />
      <MaxFeed />
    </>
  );
}

/**
 * Карточка бота: публикация, воркер, маркер и ссылка с QR-кодом.
 *
 * Данные статуса приходят тем же маршрутом, что и лента: источник один —
 * таблица `channel_state`.
 */
function BotCard() {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/demo/max-feed", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Сервер ответил кодом ${response.status}`);
        }
        const body = (await response.json()) as FeedBody;
        if (cancelled) return;
        setStatus(body.status);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Статус недоступен");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="sl-start__card">
      <div className="sl-start__row sl-start__row-between">
        <h2 className="sl-start__card-title">Бот MAX</h2>
        <a
          className="sl-start__link"
          href="/api/demo/max-feed"
          target="_blank"
          rel="noreferrer"
        >
          Открыть ленту отдельно
        </a>
      </div>

      <dl className="sl-start__status-grid">
        <div className="sl-start__status-item">
          <dt className="sl-start__status-term">Публикация</dt>
          <dd className="sl-start__status-value">
            {error ? "не удалось получить" : status?.published ? "опубликован" : "не опубликован"}
          </dd>
        </div>
        <div className="sl-start__status-item">
          <dt className="sl-start__status-term">Воркер</dt>
          <dd className="sl-start__status-value">
            {error
              ? "не удалось получить"
              : status?.worker_listening
                ? "слушает события"
                : "не запущен"}
          </dd>
        </div>
        <div className="sl-start__status-item">
          <dt className="sl-start__status-term">Маркер опроса</dt>
          <dd className="sl-start__status-value">
            {error ? "—" : (status?.marker ?? "—")}
          </dd>
        </div>
        <div className="sl-start__status-item">
          <dt className="sl-start__status-term">Режим тени</dt>
          <dd className="sl-start__status-value">
            {error ? "—" : status?.shadow_mode ? "включён" : "выключен"}
          </dd>
        </div>
      </dl>

      {error && (
        <p className="sl-start__note" role="status">
          Статус бота временно недоступен: {error}. Лента ниже обновляется
          независимо.
        </p>
      )}

      <div className="sl-start__bot">
        <div className="sl-start__qr">
          <QrCode value={BOT_LINK} />
        </div>
        <div className="sl-start__bot-info">
          <h3 className="sl-start__card-title">Ссылка на бота</h3>
          <p className="sl-start__card-lead">
            Отсканируйте код или откройте ссылку — бот отвечает в том же
            ядре, что и веб-чат.
          </p>
          <p className="sl-start__note">
            <a
              className="sl-start__link"
              href={BOT_LINK}
              target="_blank"
              rel="noreferrer"
            >
              @{BOT_USERNAME}
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Живая лента сообщений канала MAX.
 *
 * Опрос идёт только при видимом документе: пока вкладка закрыта или окно
 * свёрнуто, запросы не уходят. Текст в ленте — маскированный, исходных
 * значений клиента в ней нет.
 */
export function MaxFeed() {
  const [messages, setMessages] = useState<FeedMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/demo/max-feed", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Сервер ответил кодом ${response.status}`);
      }
      const body = (await response.json()) as FeedBody;
      setMessages(body.messages);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "лента недоступна");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const isVisible = (): boolean => document.visibilityState === "visible";

    const startPolling = (): void => {
      if (timerRef.current !== null) return;
      void load();
      timerRef.current = setInterval(() => {
        void load();
      }, POLL_INTERVAL_MS);
    };

    const stopPolling = (): void => {
      if (timerRef.current === null) return;
      clearInterval(timerRef.current);
      timerRef.current = null;
    };

    const onVisibilityChange = (): void => {
      if (isVisible()) {
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (isVisible()) {
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopPolling();
    };
  }, [load]);

  if (loading) {
    return (
      <section className="sl-start__card">
        <h2 className="sl-start__card-title">Живая лента MAX</h2>
        <p className="sl-start__state" role="status">
          Загружаем ленту сообщений…
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="sl-start__card">
        <h2 className="sl-start__card-title">Живая лента MAX</h2>
        <div className="sl-start__state sl-start__state--error" role="alert">
          <p className="sl-start__state-title">Не удалось получить ленту</p>
          <p>{error}</p>
          <button
            className="sl-start__button sl-start__button--quiet"
            type="button"
            onClick={() => {
              void load();
            }}
          >
            Повторить
          </button>
        </div>
      </section>
    );
  }

  const items = messages ?? [];

  return (
    <section className="sl-start__card">
      <h2 className="sl-start__card-title">Живая лента MAX</h2>
      {items.length === 0 ? (
        <p className="sl-start__state" role="status">
          Пока сообщений нет. Лента обновляется сама, как только в канале
          появится диалог.
        </p>
      ) : (
        <div className="sl-start__feed">
          {items.map((message) => (
            <article
              className={`sl-start__message${
                message.role === "agent" ? " sl-start__message--agent" : ""
              }`}
              key={`${message.conversation_id}-${message.created_at}-${message.role}`}
            >
              <div className="sl-start__message-head">
                <span className="sl-start__message-role">
                  {ROLE_NAMES[message.role] ?? message.role}
                </span>
                <span className="sl-start__message-time">
                  {formatTime(message.created_at)}
                </span>
              </div>
              <p className="sl-start__message-text">{message.text_masked}</p>
            </article>
          ))}
        </div>
      )}
      <p className="sl-start__note">
        В ленте только маскированный текст: имена, телефоны и адреса заменены
        метками. Обновление — раз в три секунды, пока страница на экране.
      </p>
    </section>
  );
}
