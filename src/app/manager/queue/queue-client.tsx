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
  /** Вопрос клиента: тема обращения. */
  question: string | null;
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

/** Фильтр по статусу обращения. */
type QueueStatusFilter = "all" | "open" | "closed" | "overdue";

/** Фильтр по каналу обращения. */
type QueueChannelFilter = "all" | "web" | "max";

/** Порядок сортировки обращений. */
type QueueSortOrder = "newest" | "oldest";

/**
 * Отбор обращений: поиск, фильтры и сортировка.
 *
 * Поиск идёт по вопросу клиента, сводке и короткому номеру — по тому, чем
 * обращение узнают. Фильтры по статусу и каналу сужают список, сортировка
 * задаёт порядок.
 */
function visibleItems(
  items: QueueItem[],
  query: string,
  status: QueueStatusFilter,
  channel: QueueChannelFilter,
  sort: QueueSortOrder,
): QueueItem[] {
  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (status === "overdue") {
      if (!item.overdue) return false;
    } else if (status !== "all" && item.status !== status) {
      return false;
    }
    if (channel !== "all" && item.channel !== channel) return false;
    if (needle.length === 0) return true;
    return (
      (item.question ?? "").toLowerCase().includes(needle) ||
      item.summary.toLowerCase().includes(needle) ||
      shortRef(item.id).toLowerCase().includes(needle)
    );
  });
  return [...filtered].sort((left, right) => {
    const difference =
      new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
    return sort === "newest" ? difference : -difference;
  });
}

/**
 * Короткий номер обращения.
 *
 * Полный идентификатор нечитаем, а карточек много: короткий номер
 * позволяет сослаться на обращение голосом и отличить одно от другого.
 */
function shortRef(id: string): string {
  return id.slice(0, 8);
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
  // Поиск и фильтры раздела: без них нужное обращение среди сотни
  // одинаковых карточек не найти.
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<QueueStatusFilter>("all");
  const [channelFilter, setChannelFilter] = useState<QueueChannelFilter>("all");
  const [sortOrder, setSortOrder] = useState<QueueSortOrder>("newest");
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
          {/* Заголовок раздела не повторяет название вкладки: «Очередь» и
              вкладка «Очередь» читались как дубль. */}
          <h1>Обращения и обещания</h1>
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
                <div className="queue-controls">
                  <label className="queue-control">
                    <span className="queue-control-label">Поиск</span>
                    <input
                      className="queue-search"
                      type="search"
                      value={query}
                      placeholder="Вопрос клиента или номер"
                      aria-label="Поиск по обращениям"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <label className="queue-control">
                    <span className="queue-control-label">Статус</span>
                    <select
                      className="queue-select"
                      value={statusFilter}
                      aria-label="Фильтр по статусу"
                      onChange={(event) =>
                        setStatusFilter(event.target.value as QueueStatusFilter)
                      }
                    >
                      <option value="all">Все</option>
                      <option value="open">В работе</option>
                      <option value="closed">Закрыто</option>
                      <option value="overdue">Просрочено</option>
                    </select>
                  </label>
                  <label className="queue-control">
                    <span className="queue-control-label">Канал</span>
                    <select
                      className="queue-select"
                      value={channelFilter}
                      aria-label="Фильтр по каналу"
                      onChange={(event) =>
                        setChannelFilter(event.target.value as QueueChannelFilter)
                      }
                    >
                      <option value="all">Все</option>
                      <option value="web">Веб</option>
                      <option value="max">MAX</option>
                    </select>
                  </label>
                  <label className="queue-control">
                    <span className="queue-control-label">Сортировка</span>
                    <select
                      className="queue-select"
                      value={sortOrder}
                      aria-label="Сортировка обращений"
                      onChange={(event) =>
                        setSortOrder(event.target.value as QueueSortOrder)
                      }
                    >
                      <option value="newest">Сначала новые</option>
                      <option value="oldest">Сначала старые</option>
                    </select>
                  </label>
                </div>
                <ul className="queue-list" aria-label="Обращения в очереди">
                  {visibleItems(payload.items, query, statusFilter, channelFilter, sortOrder).map((item) => (
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
                          <span className="queue-item-ref">{shortRef(item.id)}</span>
                          <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                        </span>
                        {/* Тема обращения — вопрос клиента: сводки у эскалаций
                            одинаковые, и без вопроса карточки неразличимы. */}
                        <span className="queue-item-question">
                          {item.question ?? item.summary}
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
  const [answer, setAnswer] = useState(item.draft ?? item.result ?? "");
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; title: string }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });

  /**
   * Сохранение ответа менеджера как источника базы знаний.
   *
   * Действие само является одобрением: отдельное одобрение старшего и срок
   * устаревания не требуются (R7, ADR-0019).
   */
  async function rememberAnswer(): Promise<void> {
    const text = answer.trim();
    if (text.length === 0) {
      setSaveState({
        kind: "failed",
        message: "Ответ пустой — сохранять нечего.",
      });
      return;
    }
    setSaveState({ kind: "saving" });
    try {
      const response = await fetch("/api/manager/queue/remember", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversation_id: item.conversation_id,
          body_md: text,
        }),
      });
      const body = (await response.json()) as {
        title?: string;
        error?: { message?: string };
      };
      if (!response.ok) {
        setSaveState({
          kind: "failed",
          message: body.error?.message ?? "Не удалось сохранить ответ.",
        });
        return;
      }
      setSaveState({ kind: "saved", title: body.title ?? text });
    } catch {
      setSaveState({
        kind: "failed",
        message: "Нет связи с сервером. Попробуйте позже.",
      });
    }
  }

  return (
    <article className="queue-detail-card">
      <header className="queue-detail-header">
        <div>
          <p className="queue-eyebrow">Обращение {shortRef(item.id)}</p>
          <h2>{item.question ?? item.summary}</h2>
          <p className="queue-detail-meta">
            {item.reason} · {item.channel === "max" ? "MAX" : "Веб"} · {formatDate(item.created_at)}
          </p>
          {item.question !== null ? (
            <p className="queue-detail-question">
              <span className="queue-detail-question-label">Вопрос клиента</span>
              {item.question}
            </p>
          ) : null}
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
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={7}
          aria-describedby="queue-draft-help"
        />
        <p id="queue-draft-help" className="queue-hint">
          Ответ менеджера сохраняется как источник базы знаний: следующий клиент
          получит его по тому же вопросу. Отдельное одобрение не требуется.
        </p>
        <div className="queue-actions" aria-label="Действия менеджера">
          {/*
            Незавершённые действия не показываются: пять неактивных кнопок
            «в разработке» на демо выглядят как недоделка и ничего не делают.
            Рабочее действие — «Запомнить ответ» — остаётся.
          */}
          <button
            type="button"
            onClick={() => {
              void rememberAnswer();
            }}
            disabled={saveState.kind === "saving"}
          >
            {saveState.kind === "saving" ? "Сохраняем…" : "Запомнить ответ"}
          </button>
        </div>
        {saveState.kind === "saved" ? (
          <p className="queue-hint" role="status">
            Ответ сохранён как источник базы знаний: «{saveState.title}».
          </p>
        ) : null}
        {saveState.kind === "failed" ? (
          <p className="queue-hint" role="alert">
            {saveState.message}
          </p>
        ) : null}
      </section>
    </article>
  );
}
