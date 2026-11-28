"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ManagerCard,
  ManagerEmptyState,
  ManagerErrorState,
  ManagerLoading,
} from "@/app/manager/components";
import { safeSourceHref } from "@/core/safe-link";
import { Markdown } from "@/app/components/markdown";

/**
 * Клиентская часть раздела кабинета менеджера «Песочница и история».
 *
 * Раздел состоит из двух частей:
 * 1) тестовый чат — вопрос менеджера уходит в изолированную песочницу
 *    (`POST /api/settings/sandbox`), ответ показывается с оценкой, токенами
 *    и стоимостью;
 * 2) история тестовых сессий (`GET /api/settings/history`) — по каждой
 *    сессии видны версия конфигурации, модель, оценка, токены, стоимость и
 *    время, а кнопка «Повторить» переносит вопрос обратно в песочницу.
 *
 * Изоляция песочницы объявлена на странице явно: ответ клиенту не
 * отправляется, рабочее окружение не затрагивается.
 */

type SandboxSource = {
  kind: string;
  id: string;
  title: string;
  location: string | null;
};

/** Ответ песочницы: форма — по `POST /api/settings/sandbox`. */
type SandboxResponse = {
  session_id: string;
  settings_version: number;
  outcome: string;
  grade: string;
  answer: string;
  sources: SandboxSource[];
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  trace: Array<{
    node: string;
    latency_ms: number;
    tokens_in: number;
    tokens_out: number;
    cost_rub: number;
    detail: string | null;
  }>;
};

/** Запись истории тестовых сессий: форма — по `GET /api/settings/history`. */
type HistorySession = {
  session_id: string;
  settings_version: number;
  settings_snapshot: { provider?: string; model?: string } | null;
  request_text_masked: string;
  result: {
    outcome: string;
    answer: string;
    grade: string;
    sources: SandboxSource[];
  };
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  actor: string;
  created_at: string;
};

/**
 * Подписи известных оценок.
 *
 * Сервер отдаёт оценку строкой (`ok`, `no_confirmed_source`, `invalid`).
 * Известные оценки переводим на человеческий язык, остальные показываем
 * как прислал сервер: выдумывать толкование неизвестного значения нельзя.
 */
const GRADE_LABELS: Record<string, string> = {
  ok: "хорошо",
  invalid: "плохо",
};

/** Подписи известных исходов тестовой сессии. */
const OUTCOME_LABELS: Record<string, string> = {
  respond: "ответ",
  escalate: "эскалация",
};

/** Дата и время сессии в понятном виде. */
const DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Денежная сумма с двумя знаками после запятой. */
const COST_FORMAT = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Текст ошибки из тела ответа.
 *
 * Сервер отдаёт ошибку в формате `{"error": {"code": ..., "message": ...}}`.
 * Если тела нет или оно неожиданной формы, показываем запасной текст:
 * молчать об отказе провайдера нельзя.
 */
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    const message = body?.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
    const code = body?.error?.code;
    if (typeof code === "string" && code.length > 0) {
      return `${fallback} (${code})`;
    }
  } catch {
    // Тело ответа не разобралось — показываем запасной текст.
  }
  return fallback;
}

/** Клиентская часть раздела «Песочница и история». */
export function SandboxClient() {
  const [sessions, setSessions] = useState<HistorySession[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<SandboxResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Загрузка истории тестовых сессий.
   *
   * Ошибка не теряется: текст сервера попадает в состояние ошибки, чтобы
   * менеджер видел причину, а не пустое место.
   */
  const loadHistory = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/settings/history", {
        credentials: "same-origin",
      });
      if (!response.ok) {
        setHistoryError(
          await readErrorMessage(response, "Не удалось загрузить историю тестов"),
        );
        return;
      }
      const body = (await response.json()) as { sessions?: HistorySession[] };
      setSessions(Array.isArray(body.sessions) ? body.sessions : []);
      setHistoryError(null);
    } catch {
      setHistoryError("Не удалось загрузить историю тестов");
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /**
   * Тестовый вопрос в песочнице.
   *
   * Запрос изолирован: ответ уходит только менеджеру, клиентские диалоги и
   * рабочая аналитика не затрагиваются.
   */
  async function runQuestion(): Promise<void> {
    const text = question.trim();
    if (text.length === 0 || running) {
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const response = await fetch("/api/settings/sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        setRunError(
          await readErrorMessage(response, "Не удалось выполнить тестовый запрос"),
        );
        return;
      }
      const body = (await response.json()) as SandboxResponse;
      setResult(body);
      // Новая сессия записана на сервере — обновляем историю.
      await loadHistory();
    } catch {
      setRunError("Нет связи с сервером. Попробуйте позже.");
    } finally {
      setRunning(false);
    }
  }

  /** «Повторить»: вопрос из истории переносится в поле песочницы. */
  function repeatQuestion(session: HistorySession): void {
    setQuestion(session.request_text_masked);
    setRunError(null);
    questionRef.current?.focus();
  }

  return (
    <main className="sandbox-page" aria-label="Песочница и история тестов">
      <header className="sandbox-header">
        <p className="sandbox-eyebrow">Кабинет менеджера</p>
        <h1>Песочница и история</h1>
        <p className="sandbox-isolation">
          Ответ в песочнице не отправляется клиенту: тестовая сессия
          изолирована, рабочее окружение и клиентские диалоги не
          затрагиваются. Результат видит только менеджер — в истории тестовых
          сессий.
        </p>
      </header>

      <div className="sandbox-layout">
        <ManagerCard
          id="sandbox-chat"
          title="Тестовая проверка"
          description="Задайте вопрос действующей конфигурации агента и посмотрите ответ, оценку, токены и стоимость."
        >
          <div className="sandbox-form">
            <label className="sandbox-label" htmlFor="sandbox-question">
              Вопрос для проверки
            </label>
            <textarea
              id="sandbox-question"
              ref={questionRef}
              className="sandbox-question"
              value={question}
              rows={4}
              maxLength={4000}
              placeholder="Например: какие условия по сроку оплаты?"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="sandbox-actions">
              <button
                type="button"
                className="sl-m-button sl-m-button--primary"
                onClick={() => void runQuestion()}
                disabled={running || question.trim().length === 0}
              >
                Проверить
              </button>
              {running ? (
                <p className="sandbox-running" role="status">
                  Проверяем вопрос в песочнице…
                </p>
              ) : null}
            </div>
          </div>

          {runError ? (
            <ManagerErrorState
              title="Тестовый запрос не выполнен"
              description={runError}
            />
          ) : null}

          {result ? (
            <div className="sandbox-result" aria-label="Ответ песочницы">
              <h3 className="sandbox-result__title">Ответ агента</h3>
              <div className="sandbox-result__answer">
                <Markdown source={result.answer} />
              </div>
              <ul className="sandbox-meta" aria-label="Метрики ответа">
                <li>{`Оценка: ${GRADE_LABELS[result.grade] ?? result.grade}`}</li>
                <li>{`Исход: ${OUTCOME_LABELS[result.outcome] ?? result.outcome}`}</li>
                <li>{`Токены: ${result.tokens_in} вход, ${result.tokens_out} выход`}</li>
                <li>{`Стоимость: ${COST_FORMAT.format(result.cost_rub)} ₽`}</li>
                <li>{`Версия конфигурации: ${result.settings_version}`}</li>
                <li>{`Сессия: ${result.session_id}`}</li>
              </ul>
              {result.sources.length > 0 ? (
                <>
                  <h4 className="sandbox-result__subtitle">Источники</h4>
                  <ul className="sandbox-source-list">
                    {result.sources.map((source) => {
                      // Ссылкой становится только безопасный адрес: адрес
                      // источника приходит из данных, и в `href` без проверки
                      // он мог бы выполнить код в браузере.
                      const href = safeSourceHref(source.location);
                      const label = source.title ?? source.location ?? source.id;
                      return (
                        <li key={`${source.kind}-${source.id}`}>
                          {href ? (
                            <a
                              className="sandbox-source-link"
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {label}
                            </a>
                          ) : (
                            label
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </ManagerCard>

        <ManagerCard
          id="sandbox-history"
          title="История тестов"
          description="Проверки, которые менеджер уже запускал: версия конфигурации, модель, оценка, токены и стоимость."
        >
          {historyError ? (
            <ManagerErrorState
              title="Не удалось загрузить историю тестов"
              description={historyError}
            />
          ) : sessions === null ? (
            <ManagerLoading label="Загружаем историю тестов…" />
          ) : sessions.length === 0 ? (
            <ManagerEmptyState
              title="История тестов пуста"
              description="Запустите первую проверку в песочнице — она появится здесь."
            />
          ) : (
            <ul className="sandbox-history" aria-label="История тестовых сессий">
              {sessions.map((session) => (
                <li key={session.session_id} className="sandbox-history__item">
                  <div className="sandbox-history__top">
                    <span>{`Сессия: ${session.session_id}`}</span>
                    <time dateTime={session.created_at}>
                      {`Время: ${DATE_FORMAT.format(new Date(session.created_at))}`}
                    </time>
                  </div>
                  <p className="sandbox-history__question">
                    {session.request_text_masked}
                  </p>
                  <div className="sandbox-history__answer">
                    <Markdown source={session.result.answer} />
                  </div>
                  <ul className="sandbox-meta">
                    <li>{`Версия конфигурации: ${session.settings_version}`}</li>
                    <li>{`Модель: ${session.settings_snapshot?.model ?? "не указана"}`}</li>
                    <li>{`Оценка: ${GRADE_LABELS[session.result.grade] ?? session.result.grade}`}</li>
                    <li>{`Исход: ${OUTCOME_LABELS[session.result.outcome] ?? session.result.outcome}`}</li>
                    <li>{`Токены: ${session.tokens_in} вход, ${session.tokens_out} выход`}</li>
                    <li>{`Стоимость: ${COST_FORMAT.format(session.cost_rub)} ₽`}</li>
                  </ul>
                  <button
                    type="button"
                    className="sandbox-history__repeat"
                    aria-label={`Повторить вопрос: ${session.request_text_masked}`}
                    onClick={() => repeatQuestion(session)}
                  >
                    Повторить
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ManagerCard>
      </div>
    </main>
  );
}
