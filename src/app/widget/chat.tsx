"use client";

import { useState } from "react";
import { safeSourceHref } from "@/core/safe-link";

/**
 * Минимальный веб-виджет чата для ручной проверки.
 *
 * Оформление — только через CSS-переменные из src/app/styles/tokens.css:
 * жёстко прописанных цветов в виджете нет.
 *
 * Идентификатор диалога виджет берёт из ответа сервера и помнит его в
 * состоянии страницы: cookie диалога подписана и помечена `HttpOnly`, из
 * JavaScript она не читается. На первом ходу идентификатор новый, дальше —
 * тот же, что вернул сервер: иначе сверка тела с cookie даёт `403` и
 * виджет работает только один ход за сессию.
 */

type Source = {
  kind: string;
  id: string;
  title: string;
  location: string | null;
};

type ChatState = {
  role: "client" | "agent";
  text: string;
  sources?: Source[];
  escalation?: { reason: string; summary: string } | null;
};

const DEMO_QUESTION =
  "Здравствуйте! Как получить электронную лицензию на программное обеспечение?";

/**
 * Ключ хранения идентификатора диалога.
 *
 * Хранилище выбирается по вкладке: диалог клиента не должен переезжать в
 * соседнюю вкладку того же браузера.
 */
const CONVERSATION_STORAGE_KEY = "support_conversation_id";

/** Идентификатор диалога текущей вкладки или `null`. */
function readStoredConversationId(): string | null {
  try {
    return window.sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
  } catch {
    // Приватный режим браузера может запрещать хранилище: тогда диалог
    // начнётся заново в следующей вкладке.
    return null;
  }
}

/** Запоминает идентификатор диалога для следующих ходов. */
function storeConversationId(conversationId: string): void {
  try {
    window.sessionStorage.setItem(CONVERSATION_STORAGE_KEY, conversationId);
  } catch {
    // Хранилище недоступно — ход продолжится с идентификатором из ответа.
  }
}

export function Chat() {
  const [messages, setMessages] = useState<ChatState[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(() =>
    readStoredConversationId(),
  );

  /** Запрос хода с указанным идентификатором диалога. */
  async function postMessage(
    message: string,
    conversation: string,
  ): Promise<Response> {
    // Путь из замороженного контракта (docs/api-contract.md §4).
    // Маршрут Next обслуживается как /api/chat; переадресацию /v1/chat
    // добавляет exec в next.config.ts (файл общий, срез его не трогает).
    return fetch("/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversation,
        message: { client_message_id: crypto.randomUUID(), text: message },
      }),
    });
  }

  async function send() {
    const message = text.trim();
    if (message.length === 0 || pending) return;

    setMessages((current) => [...current, { role: "client", text: message }]);
    setText("");
    setPending(true);

    // Первый ход — с новым идентификатором, дальше — с тем, что вернул
    // сервер: идентификатор из тела запроса должен совпадать с cookie.
    const requestConversationId = conversationId ?? crypto.randomUUID();

    try {
      let response = await postMessage(message, requestConversationId);

      if (response.status === 403) {
        // Идентификатор разошёлся с подписанной cookie (например, хранилище
        // вкладки очистили, а cookie осталась). Сервер возвращает
        // идентификатор своего диалога в деталях ошибки — повторяем ход с
        // ним.
        const refused = (await response.json().catch(() => null)) as {
          error?: { details?: { conversation_id?: string } };
        } | null;
        const serverConversationId = refused?.error?.details?.conversation_id;
        if (serverConversationId) {
          response = await postMessage(message, serverConversationId);
        }
      }

      const body = (await response.json().catch(() => null)) as {
        conversation_id?: string;
        outcome?: "respond" | "escalate";
        answer: { text: string; sources: Source[] } | null;
        escalation: { reason: string; summary: string } | null;
        error?: { code?: string; message?: string };
      } | null;

      // Идентификатор диалога сервера запоминается: следующий ход идёт с
      // ним, и сверка с cookie проходит.
      if (body?.conversation_id) {
        setConversationId(body.conversation_id);
        storeConversationId(body.conversation_id);
      }

      if (!response.ok || !body) {
        // Ответ не прошёл проверку: обращение уже ушло менеджеру, и клиент
        // должен видеть человеческую фразу, а не техническую заглушку.
        // Само тело ошибки клиенту не показывается — оно для журнала.
        //
        // Код `approval_required` означает, что ответ не прошёл проверку и
        // ушёл менеджеру: клиенту об этом и говорим. Любой другой отказ —
        // тоже эскалация, но с общей фразой.
        const escalated =
          body?.escalation?.summary ??
          (body?.error?.code === "approval_required"
            ? "Обращение передано менеджеру."
            : null);
        setMessages((current) => [
          ...current,
          {
            role: "agent",
            text: escalated ?? "Обращение передано менеджеру.",
            escalation: body?.escalation ?? null,
          },
        ]);
        return;
      }

      if (body.outcome === "respond" && body.answer) {
        setMessages((current) => [
          ...current,
          {
            role: "agent",
            text: body.answer?.text ?? "",
            sources: body.answer?.sources ?? [],
          },
        ]);
        return;
      }

      setMessages((current) => [
        ...current,
        {
          role: "agent",
          text: body.escalation?.summary ?? "Обращение передано менеджеру.",
          escalation: body.escalation ?? null,
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        { role: "agent", text: "Нет связи с сервером. Попробуйте позже." },
      ]);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="chat" aria-label="Чат поддержки">
      <header className="chat__header">
        <h1 className="chat__title">Поддержка ПАО «Софтлайн»</h1>
      </header>

      <div className="chat__log" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <p className="chat__hint">
            Задайте вопрос — агент ответит по опубликованной базе знаний или
            передаст обращение менеджеру.
          </p>
        ) : (
          messages.map((message, index) => (
            <article
              key={index}
              className={
                message.role === "client" ? "chat__message chat__message--client" : "chat__message chat__message--agent"
              }
            >
              <p className="chat__message-text">{message.text}</p>

              {message.sources && message.sources.length > 0 ? (
                <ul className="chat__sources">
                  {message.sources.map((source) => {
                    // Ссылкой становится только безопасный адрес: адрес
                    // источника приходит из данных, и в `href` без проверки
                    // он мог бы выполнить код в браузере клиента.
                    const href = safeSourceHref(source.location);
                    return (
                      <li key={source.id} className="chat__source">
                        {href ? (
                          <a
                            className="chat__source-title chat__source-title--link"
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {source.title}
                          </a>
                        ) : (
                          <span className="chat__source-title">{source.title}</span>
                        )}
                        {source.location ? (
                          <span className="chat__source-location">{source.location}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {message.escalation ? (
                <p className="chat__escalation">
                  Обращение передано менеджеру ({message.escalation.reason}).
                </p>
              ) : null}
            </article>
          ))
        )}
      </div>

      <form
        className="chat__form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className="chat__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Введите вопрос"
          rows={3}
          maxLength={4000}
          aria-label="Сообщение"
        />
        <div className="chat__actions">
          <button
            type="button"
            className="chat__demo"
            onClick={() => setText(DEMO_QUESTION)}
          >
            Пример вопроса
          </button>
          <button
            type="submit"
            className="chat__send"
            disabled={pending || text.trim().length === 0}
          >
            {pending ? "Отправка…" : "Отправить"}
          </button>
        </div>
      </form>
    </section>
  );
}
