"use client";

import { useState } from "react";

/**
 * Минимальный веб-виджет чата для ручной проверки.
 *
 * Оформление — только через CSS-переменные из src/app/styles/tokens.css:
 * жёстко прописанных цветов в виджете нет.
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

export function Chat() {
  const [messages, setMessages] = useState<ChatState[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  async function send() {
    const message = text.trim();
    if (message.length === 0 || pending) return;

    setMessages((current) => [...current, { role: "client", text: message }]);
    setText("");
    setPending(true);

    try {
      // Путь из замороженного контракта (docs/api-contract.md §4).
      // Маршрут Next обслуживается как /api/chat; переадресацию /v1/chat
      // добавляет exec в next.config.ts (файл общий, срез его не трогает).
      const response = await fetch("/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversation_id: crypto.randomUUID(),
          message: { client_message_id: crypto.randomUUID(), text: message },
        }),
      });

      if (!response.ok) {
        setMessages((current) => [
          ...current,
          {
            role: "agent",
            text: "Не удалось обработать запрос. Попробуйте позже.",
          },
        ]);
        return;
      }

      const body = (await response.json()) as {
        outcome: "respond" | "escalate";
        answer: { text: string; sources: Source[] } | null;
        escalation: { reason: string; summary: string } | null;
      };

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
                  {message.sources.map((source) => (
                    <li key={source.id} className="chat__source">
                      <span className="chat__source-title">{source.title}</span>
                      {source.location ? (
                        <span className="chat__source-location">{source.location}</span>
                      ) : null}
                    </li>
                  ))}
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
