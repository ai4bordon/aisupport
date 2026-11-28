"use client";

import { useEffect, useState } from "react";
import {
  ManagerCard,
  ManagerEmptyState,
  ManagerErrorState,
  ManagerLoading,
} from "@/app/manager/components";

/**
 * Клиентская часть раздела кабинера «Аналитика».
 *
 * Раздел показывает четыре измеренные метрики по фактическим трассам
 * агента: стоимость диалога, долю автозакрытия, средний первый ответ и
 * пробелы в базе знаний.
 *
 * Все состояния явные: загрузка, ошибка загрузки и пустое состояние.
 * Пустое состояние — это «обращений ещё не было», а не ошибка: раздел
 * показывает честный ноль, а не выдуманные проценты.
 *
 * Данные приходят с маршрута `/api/manager/analytics`; клиент их не
 * пересчитывает и не подставляет собственные значения: показанное число —
 * это измеренная величина с сервера.
 */

/** Тело ответа маршрута данных раздела. */
type AnalyticsPayload = {
  data_origin: "demo_synthetic" | "customer";
  origin_note: string;
  cost: {
    dialogs: number;
    total_rub: number;
    avg_rub: number;
    min_rub: number;
    max_rub: number;
    tokens_in: number;
    tokens_out: number;
  };
  auto_close: {
    dialogs_total: number;
    closed_by_agent: number;
    share: number;
    without_manager: number;
    with_manager_confirmed_quote: number;
  };
  first_response: {
    samples: number;
    avg_ms: number;
    target_ms: number;
    meets_target: boolean;
  };
  knowledge_gaps: Array<{
    intent: string;
    node: string;
    count: number;
  }>;
};

/** Стоимость в рублях: два знака, как в платёжных документах. */
function formatRub(value: number): string {
  return `${value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

/** Доля в процентах: целая часть, без выдуманной точности. */
function formatShare(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/** Длительность в секундах: при больших значениях — в минутах. */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} с`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes} мин` : `${minutes} мин ${seconds} с`;
}

/**
 * Число обращений с правильной формой слова.
 *
 * Форма в русском языке зависит от числа: «1 обращение», «2 обращения»,
 * «5 обращений». Подпись метрики читается вслух, поэтому форма важна.
 */
function plural(count: number, forms: [string, string, string]): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  const mod10 = count % 10;
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

export function AnalyticsClient() {
  const [payload, setPayload] = useState<AnalyticsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/manager/analytics", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        setPayload((await response.json()) as AnalyticsPayload);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("Не удалось загрузить аналитику");
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <main className="analytics-page" aria-label="Аналитика обращений">
        <ManagerErrorState
          title="Не удалось загрузить аналитику"
          description="Повторите попытку позже или обновите страницу."
        />
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="analytics-page" aria-label="Аналитика обращений">
        <ManagerLoading label="Загружаем аналитику…" />
      </main>
    );
  }

  const dialogs = payload.cost.dialogs;

  if (dialogs === 0) {
    return (
      <main className="analytics-page" aria-label="Аналитика обращений">
        <header className="analytics-header">
          <p className="analytics-eyebrow">Кабинет менеджера</p>
          <h1 className="analytics-title">Аналитика</h1>
        </header>
        <ManagerEmptyState
          title="Обращений пока нет"
          description="Метрики появятся, когда агент обработает первое обращение: показывать цифры без записанных трасс нельзя."
        />
      </main>
    );
  }

  const withoutManagerWord = plural(
    payload.auto_close.without_manager,
    ["обращение", "обращения", "обращений"],
  );
  const withQuoteWord = plural(
    payload.auto_close.with_manager_confirmed_quote,
    ["обращение", "обращения", "обращений"],
  );

  return (
    <main className="analytics-page" aria-label="Аналитика обращений">
      <header className="analytics-header">
        <div>
          <p className="analytics-eyebrow">Кабинет менеджера</p>
          <h1 className="analytics-title">Аналитика</h1>
        </div>
        <p className="analytics-origin" role="note">
          {payload.origin_note}
        </p>
      </header>

      <ManagerCard
        id="analytics-cost"
        title="Стоимость диалога"
        description={`По ${plural(dialogs, ["диалогу", "диалогам", "диалогам"])} с записанной трассой. Стоимость берётся из трассы агента, а не оценивается.`}
      >
        <dl className="analytics-metrics">
          <div className="analytics-metric">
            <dt>Средняя</dt>
            <dd>{formatRub(payload.cost.avg_rub)}</dd>
          </div>
          <div className="analytics-metric">
            <dt>Минимальная</dt>
            <dd>{formatRub(payload.cost.min_rub)}</dd>
          </div>
          <div className="analytics-metric">
            <dt>Максимальная</dt>
            <dd>{formatRub(payload.cost.max_rub)}</dd>
          </div>
          <div className="analytics-metric">
            <dt>Всего за период</dt>
            <dd>{formatRub(payload.cost.total_rub)}</dd>
          </div>
        </dl>
        <p className="analytics-note">
          Токены: {payload.cost.tokens_in} входящих и {payload.cost.tokens_out}{" "}
          исходящих.
        </p>
      </ManagerCard>

      <ManagerCard
        id="analytics-auto-close"
        title="Доля автозакрытия"
        description="Считается по двум вариантам заказчика: ответ агента без менеджера и КП, подтверждённое менеджером."
      >
        <p className="analytics-headline">{formatShare(payload.auto_close.share)}</p>
        <ul className="analytics-list">
          <li>
            {payload.auto_close.without_manager} {withoutManagerWord} закрыл агент без
            менеджера
          </li>
          <li>
            {payload.auto_close.with_manager_confirmed_quote} {withQuoteWord} закрыто по
            подтверждённому КП
          </li>
        </ul>
        <p className="analytics-note">
          Всего обращений в выборке: {payload.auto_close.dialogs_total}, закрыто
          агентом: {payload.auto_close.closed_by_agent}.
        </p>
      </ManagerCard>

      <ManagerCard
        id="analytics-first-response"
        title="Средний первый ответ"
        description="От первого сообщения клиента до первого ответа агента по переписке диалога."
      >
        <p className="analytics-headline">
          {/* Ноль секунд рядом с ориентиром читался как сбой. Различаем
              два случая: замеров нет вовсе и ответ пришёл мгновенно. */}
          {payload.first_response.samples === 0
            ? "нет замеров"
            : payload.first_response.avg_ms < 1000
              ? "мгновенный ответ"
              : formatDuration(payload.first_response.avg_ms)}
        </p>
        <p className="analytics-note">
          {payload.first_response.samples === 0
            ? "Замеров пока нет: ответы агента ещё не фиксировались по переписке диалога."
            : `Ориентир 2 минуты — ${payload.first_response.meets_target
                ? "среднее время укладывается в ориентир"
                : "среднее время не укладывается в ориентир"}. Замеров: ${payload.first_response.samples}.`}
        </p>
      </ManagerCard>

      <ManagerCard
        id="analytics-knowledge-gaps"
        title="Пробелы базы знаний"
        description="Вопросы, по которым подтверждённого источника не нашлось. Список собран из записанных трасс, а не придуман."
      >
        {payload.knowledge_gaps.length === 0 ? (
          <ManagerEmptyState
            title="Пробелов не зафиксировано"
            description="За период ни один вопрос не остался без подтверждённого источника."
          />
        ) : (
          <ul className="analytics-gaps">
            {payload.knowledge_gaps.map((gap) => (
              <li key={`${gap.intent}-${gap.node}`} className="analytics-gap">
                <span className="analytics-gap__intent">{gap.intent}</span>
                <span className="analytics-gap__count">
                  {gap.count}{" "}
                  {plural(gap.count, ["обращение", "обращения", "обращений"])}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ManagerCard>
    </main>
  );
}
