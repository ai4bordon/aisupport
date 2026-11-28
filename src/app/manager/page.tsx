import type { Metadata } from "next";
import Link from "next/link";
import { getPool } from "@/db/pool";
import { getTenantId } from "@/db/tenant";
import { ManagerCard } from "./components/managerCard";
import { MANAGER_SECTIONS } from "./components/managerSections";

export const metadata: Metadata = {
  title: "Кабинет менеджера — Софтлайн Решения",
  description:
    "Кабинет менеджера ИИ-агента поддержки: очередь обращений, база знаний, настройки агента, аналитика и песочница.",
};

/**
 * Обзор кабинета менеджера.
 *
 * Обзор показывает фактическое состояние стенда: сколько обращений ждёт
 * менеджера, сколько обещаний просрочено, что нового в базе знаний. Раньше
 * здесь были пять одинаковых карточек «раздел готов» с кнопкой «Открыть
 * раздел» — точный дубль левого меню, и первое, что видел менеджер, не
 * говорило ни о чём.
 *
 * Цифры считает сервер: выдуманные показатели в обзоре вводили бы в
 * заблуждение.
 */

/** Фактическое состояние стенда. */
type Overview = {
  /** Обращений, ждущих менеджера. */
  openEscalations: number;
  /** Обещаний, срок которых истёк. */
  overduePromises: number;
  /** Статей в базе знаний, ожидающих решения. */
  pendingArticles: number;
  /** Документов, ожидающих одобрения. */
  pendingDocuments: number;
};

async function readOverview(): Promise<Overview> {
  const pool = getPool();
  const escalations = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM escalations
      WHERE tenant_id = $1 AND status = 'open'`,
    [await getTenantId()],
  );
  const promises = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM promises
      WHERE tenant_id = $1 AND status = 'open' AND due_at < now()`,
    [await getTenantId()],
  );
  const articles = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM kb_articles
      WHERE tenant_id = $1 AND status = 'pending_review'`,
    [await getTenantId()],
  );
  const documents = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM kb_documents
      WHERE tenant_id = $1 AND status = 'pending'`,
    [await getTenantId()],
  );

  return {
    openEscalations: Number(escalations.rows[0]?.count ?? "0"),
    overduePromises: Number(promises.rows[0]?.count ?? "0"),
    pendingArticles: Number(articles.rows[0]?.count ?? "0"),
    pendingDocuments: Number(documents.rows[0]?.count ?? "0"),
  };
}

/**
 * Число с подписью во множественном числе.
 *
 * Подпись рядом с числом: «3 обращения», «1 обращение», «5 обращений» —
 * иначе число читается как технический счётчик.
 */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export default async function ManagerOverviewPage() {
  let overview: Overview = {
    openEscalations: 0,
    overduePromises: 0,
    pendingArticles: 0,
    pendingDocuments: 0,
  };
  let available = true;
  try {
    overview = await readOverview();
  } catch {
    // База недоступна — обзор показывает честное состояние «нет данных»,
    // а не выдуманные нули.
    available = false;
  }

  const facts = available
    ? [
        {
          id: "fact-queue",
          label: "Ждут менеджера",
          value: String(overview.openEscalations),
          detail: plural(
            overview.openEscalations,
            "обращение",
            "обращения",
            "обращений",
          ),
          href: "/manager/queue",
        },
        {
          id: "fact-promises",
          label: "Просроченные обещания",
          value: String(overview.overduePromises),
          detail: plural(
            overview.overduePromises,
            "обещание",
            "обещания",
            "обещаний",
          ),
          href: "/manager/queue",
        },
        {
          id: "fact-articles",
          label: "Статьи ждут решения",
          value: String(overview.pendingArticles),
          detail: plural(
            overview.pendingArticles,
            "статья",
            "статьи",
            "статей",
          ),
          href: "/manager/knowledge",
        },
        {
          id: "fact-documents",
          label: "Документы ждут одобрения",
          value: String(overview.pendingDocuments),
          detail: plural(
            overview.pendingDocuments,
            "документ",
            "документа",
            "документов",
          ),
          href: "/manager/knowledge",
        },
      ]
    : [];

  return (
    <div className="sl-m-page">
      <header className="sl-m-page__header">
        <h1 className="sl-m-page__title">Кабинет менеджера</h1>
        <p className="sl-m-page__lead">
          Что ждёт менеджера прямо сейчас. Цифры считает сервер по рабочим
          данным, а разделы кабинета — в меню слева.
        </p>
      </header>

      {available ? (
        <section aria-label="Состояние стенда">
          <ul className="sl-m-facts">
            {facts.map((fact) => (
              <li key={fact.id} className="sl-m-fact">
                <Link className="sl-m-fact__link" href={fact.href}>
                  <span className="sl-m-fact__value">{fact.value}</span>
                  <span className="sl-m-fact__label">{fact.label}</span>
                  <span className="sl-m-fact__detail">{fact.detail}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <ManagerCard
          id="overview-unavailable"
          title="Данные недоступны"
          description="Сводка не собрана: база сейчас недоступна. Разделы кабинета доступны в меню."
        />
      )}

      <section aria-label="Разделы кабинета">
        <ul className="sl-m-sections">
          {MANAGER_SECTIONS.filter((section) => section.id !== "overview").map(
            (section) => (
              <li key={section.id} className="sl-m-sections__item">
                <ManagerCard
                  id={section.anchor}
                  title={section.label}
                  description={section.summary}
                  footer={
                    section.status === "in-progress" ? (
                      <span className="sl-m-badge sl-m-badge--pending">
                        Раздел в работе
                      </span>
                    ) : (
                      <Link className="sl-m-link" href={section.href}>
                        Открыть раздел
                      </Link>
                    )
                  }
                />
              </li>
            ),
          )}
        </ul>
      </section>
    </div>
  );
}
