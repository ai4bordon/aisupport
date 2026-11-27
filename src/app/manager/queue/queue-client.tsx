"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PromiseJournal, type PromiseItem } from "./promises";

type QueueStep = {
  node: string;
  endpoint: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: string;
  latency_ms: number;
  created_at: string;
};

type QueueItem = {
  id: string;
  conversation_id: string;
  reason: string;
  summary: string;
  draft: string | null;
  sources: Array<{ kind?: string; id?: string; title?: string; location?: string }>;
  status: string;
  sla_due_at: string | null;
  overdue: boolean;
  created_at: string;
  channel: string;
  result: string;
  trace_ref: string;
  is_shadow: boolean;
  steps: QueueStep[];
  promises: PromiseItem[];
};

type QueuePayload = {
  items: QueueItem[];
  promises: PromiseItem[];
};

const STATUS_LABELS: Record<string, string> = {
  open: "В работе",
  closed: "Закрыто",
  done: "Выполнено",
  overdue: "Просрочено",
};

/**
 * Подпись статуса обращения.
 *
 * Просрочка приходит сервером отдельным признаком: статус в базе
 * ограничен ('open','closed'), поэтому «Просрочено» — вычисляемое
 * состояние по сроку SLA.
 */
function statusLabel(status: string, overdue: boolean): string {
  if (overdue) return "Просрочено";
  return STATUS_LABELS[status] ?? status;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatCost(value: string): string {
  const amount = Number(value);
  return `${amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function sourceTitle(source: QueueItem["sources"][number]): string {
  return source.title ?? source.location ?? source.id ?? source.kind ?? "Источник";
}

/** Клиентская часть очереди: загрузка данных, состояния и раскрытие обращения. */
export function QueueClient() {
  const [payload, setPayload] = useState<QueuePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"queue" | "promises">("queue");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queueTabRef = useRef<HTMLButtonElement>(null);
  const promisesTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/manager/queue", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as QueuePayload;
        setPayload(data);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("Не удалось загрузить очередь");
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  function switchTab(tab: "queue" | "promises"): void {
    setActiveTab(tab);
    const target = tab === "queue" ? queueTabRef.current : promisesTabRef.current;
    target?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      switchTab("promises");
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      switchTab("queue");
    }
  }

  if (error) {
    return (
      <main className="queue-page" aria-label="Очередь обращений">
        <div className="queue-state queue-state--error" role="alert">
          <h1>Не удалось загрузить очередь</h1>
          <p>Повторите попытку позже или обновите страницу.</p>
        </div>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="queue-page" aria-label="Очередь обращений">
        <div className="queue-state" role="status">
          Загружаем очередь…
        </div>
      </main>
    );
  }

  const selected = payload.items.find((item) => item.id === selectedId) ?? null;

  return (
    <main className="queue-page" aria-label="Очередь обращений">
      <header className="queue-header">
        <div>
          <p className="queue-eyebrow">Кабинет менеджера</p>
          <h1>Очередь</h1>
        </div>
        <div className="queue-tabs" role="tablist" aria-label="Разделы очереди">
          <button
            ref={queueTabRef}
            type="button"
            role="tab"
            id="queue-tab"
            aria-selected={activeTab === "queue"}
            aria-controls="queue-panel"
            tabIndex={activeTab === "queue" ? 0 : -1}
            className="queue-tab"
            onClick={() => switchTab("queue")}
            onKeyDown={onTabKeyDown}
          >
            Очередь <span className="queue-count">{payload.items.length}</span>
          </button>
          <button
            ref={promisesTabRef}
            type="button"
            role="tab"
            id="promises-tab"
            aria-selected={activeTab === "promises"}
            aria-controls="queue-panel"
            tabIndex={activeTab === "promises" ? 0 : -1}
            className="queue-tab"
            onClick={() => switchTab("promises")}
            onKeyDown={onTabKeyDown}
          >
            Журнал обещаний <span className="queue-count">{payload.promises.length}</span>
          </button>
        </div>
      </header>

      <div
        id="queue-panel"
        role="tabpanel"
        aria-labelledby={activeTab === "queue" ? "queue-tab" : "promises-tab"}
        className="queue-panel"
      >
        {activeTab === "queue" ? (
          payload.items.length === 0 ? (
            <section className="queue-empty" aria-label="Пустая очередь">
              <p>Очередь пуста</p>
            </section>
          ) : (
            <div className="queue-layout">
              <section className="queue-list-panel" aria-label="Список обращений">
                <h2 className="queue-section-title">Обращения в очереди</h2>
                <ul className="queue-list" aria-label="Обращения в очереди">
                  {payload.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="queue-item"
                        aria-expanded={selectedId === item.id}
                        aria-label={`Открыть обращение: ${item.summary}`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className="queue-item-top">
                          <span>{item.channel === "max" ? "MAX" : "Веб"}</span>
                          <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                        </span>
                        <span className="queue-item-summary">{item.summary}</span>
                        <span className="queue-item-meta">
                          {item.reason} · {statusLabel(item.status, item.overdue)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="queue-detail" aria-label="Раскрытое обращение">
                {selected ? (
                  <QueueDetail item={selected} />
                ) : (
                  <p className="queue-hint">Выберите обращение в очереди</p>
                )}
              </section>
            </div>
          )
        ) : (
          <PromiseJournal promises={payload.promises} />
        )}
      </div>
    </main>
  );
}

function QueueDetail({ item }: { item: QueueItem }) {
  const totalCost = item.steps.reduce((sum, step) => sum + Number(step.cost_rub), 0);

  return (
    <article className="queue-detail-card">
      <header className="queue-detail-header">
        <div>
          <p className="queue-eyebrow">Обращение</p>
          <h2>{item.summary}</h2>
          <p className="queue-detail-meta">
            {item.reason} · {item.channel === "max" ? "MAX" : "Веб"} · {formatDate(item.created_at)}
          </p>
        </div>
        <span
          className={item.overdue ? "queue-status queue-status--overdue" : "queue-status"}
        >
          {statusLabel(item.status, item.overdue)}
        </span>
      </header>

      <section aria-labelledby="queue-trace-title" className="queue-card">
        <h3 id="queue-trace-title">Что сделала программа</h3>
        {item.steps.length === 0 ? (
          <p>Трасса для этого обращения отсутствует.</p>
        ) : (
          <ol className="queue-trace-list">
            {item.steps.map((step, index) => (
              <li key={`${step.node}-${step.created_at}-${index}`}>
                <strong>{step.node}</strong>
                {step.endpoint ? <span> · {step.endpoint}</span> : null}
                <span>
                  {" "}· {step.latency_ms} мс · {step.tokens_in + step.tokens_out} токенов
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="queue-cost">
          Сколько стоило: <strong>{formatCost(String(totalCost))}</strong>
        </p>
      </section>

      <section aria-labelledby="queue-promises-title" className="queue-card">
        <h3 id="queue-promises-title">Что пообещала</h3>
        {item.promises.length === 0 ? (
          <p>По этому диалогу обещаний нет.</p>
        ) : (
          <ul className="queue-detail-promise-list">
            {item.promises.map((promise) => (
              <li key={promise.id}>
                <span>{promise.text}</span>
                <span>
                  {formatDate(promise.due_at)} · {promise.owner} ·{" "}
                  {STATUS_LABELS[promise.status] ?? promise.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="queue-sources-title" className="queue-card">
        <h3 id="queue-sources-title">Источники</h3>
        {item.sources.length === 0 ? (
          <p>Источники не указаны.</p>
        ) : (
          <ul className="queue-source-list">
            {item.sources.map((source, index) => (
              <li key={`${source.id ?? source.title ?? "source"}-${index}`}>
                {sourceTitle(source)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="queue-draft-title" className="queue-card">
        <h3 id="queue-draft-title">Черновик ответа менеджера</h3>
        <label className="queue-draft-label" htmlFor="queue-draft">
          Текст ответа
        </label>
        <textarea
          id="queue-draft"
          className="queue-draft"
          defaultValue={item.draft ?? item.result ?? ""}
          rows={7}
          aria-describedby="queue-draft-help"
        />
        <p id="queue-draft-help" className="queue-hint">
          Правка остаётся в браузере: серверного маршрута для сохранения черновика пока нет,
          он подключается командой интеграции.
        </p>
        <div className="queue-actions" aria-label="Действия менеджера">
          <button type="button" disabled title="В разработке">
            Сохранить черновик <small>в разработке</small>
          </button>
          <button type="button" disabled title="В разработке">
            Отправить клиенту <small>в разработке</small>
          </button>
          <button type="button" disabled title="В разработке">
            Вернуть агенту <small>в разработке</small>
          </button>
          <button type="button" disabled title="В разработке">
            Отложить <small>в разработке</small>
          </button>
          <button type="button" disabled title="В разработке">
            Написать статью <small>в разработке</small>
          </button>
          <button type="button" disabled title="В разработке">
            Запомнить ответ <small>в разработке</small>
          </button>
        </div>
      </section>
    </article>
  );
}
