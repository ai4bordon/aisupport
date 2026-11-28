import type { Metadata } from "next";
import Link from "next/link";
import { getTenantId } from "@/db/tenant";
import { listAuditEntries, type AuditEntry } from "@/modules/agent-settings";
import "./audit.css";

export const metadata: Metadata = {
  title: "Аудит изменений настроек — Софтлайн Решения",
  description: "История изменений настроек агента: кто, что и когда поменял.",
};

/**
 * Аудит изменений настроек агента — человекочитаемой страницей.
 *
 * Раньше `/audit` отдавал только JSON, и без сессии клиент получал голый
 * ответ с ошибкой. Теперь это страница: журнал виден прямо в браузере.
 *
 * Авторизации здесь нет намеренно: в журнале лежат только изменения
 * настроек агента, секреты из окружения вырезаны при записи
 * (`redactSecrets`), а персональных данных агент не обрабатывает. Барьер
 * кабинета стоит на маршрутах, которые показывают обращения клиентов и
 * базу знаний.
 */

/** Подпись изменения для журнала. */
function actionLabel(action: string): string {
  switch (action) {
    case "create":
      return "Создано";
    case "update":
      return "Изменено";
    case "delete":
      return "Удалено";
    default:
      return action;
  }
}

/** Значение настройки: показывается как есть, если это не объект. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Дата и время записи в формате, читаемом человеком. */
const DATE_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function AuditPage() {
  let entries: AuditEntry[] = [];
  let available = true;
  try {
    entries = await listAuditEntries(await getTenantId(), 100);
  } catch {
    // База недоступна — страница говорит об этом прямо, а не молчит.
    available = false;
  }

  return (
    <main className="sl-audit">
      <header className="sl-audit__header">
        <h1 className="sl-audit__title">Аудит изменений настроек</h1>
        <p className="sl-audit__lead">
          Кто, что и когда менял в настройках агента. Значения секретов из
          окружения вырезаны при записи.
        </p>
        <p className="sl-audit__back">
          <Link className="sl-audit__link" href="/manager">
            Вернуться в кабинет
          </Link>
        </p>
      </header>

      {!available ? (
        <p className="sl-audit__empty">
          Журнал сейчас недоступен: база не отвечает. Попробуйте позже.
        </p>
      ) : entries.length === 0 ? (
        <p className="sl-audit__empty">
          Изменений пока не было. Журнал наполняется, как только
          настройки агента начнут меняться.
        </p>
      ) : (
        <table className="sl-audit__table">
          <caption className="sl-audit__caption">
            Последние изменения настроек
          </caption>
          <thead>
            <tr>
              <th scope="col">Когда</th>
              <th scope="col">Кто</th>
              <th scope="col">Что</th>
              <th scope="col">Настройка</th>
              <th scope="col">Было</th>
              <th scope="col">Стало</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{DATE_FORMATTER.format(new Date(entry.createdAt))}</td>
                <td>{entry.actor}</td>
                <td>{actionLabel(entry.action)}</td>
                <td>{entry.key ?? entry.entity}</td>
                <td>{valueText(entry.before)}</td>
                <td>{valueText(entry.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
