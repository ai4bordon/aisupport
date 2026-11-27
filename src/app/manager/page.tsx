import type { Metadata } from "next";
import Link from "next/link";
import { ManagerButton } from "./components/managerButton";
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
 * Страница честно перечисляет разделы кабинета и их состояние: готовые
 * разделы ведут в работу, неготовые помечены «раздел в работе» и не
 * имитируют содержимое — кнопка открытия такого раздела выключена.
 *
 * Данных здесь нет намеренно: обзор описывает состав кабинета, а не
 * показывает выдуманные цифры.
 */
export default function ManagerOverviewPage() {
  return (
    <div className="sl-m-page">
      <header className="sl-m-page__header">
        <h1 className="sl-m-page__title">Кабинет менеджера</h1>
        <p className="sl-m-page__lead">
          Рабочее место менеджера ИИ-агента поддержки: обращения, требующие
          человека, база знаний, настройки агента, аналитика и песочница.
          Разделы, которые ещё собираются, помечены честно — без имитации
          работы.
        </p>
      </header>

      <div className="sl-m-grid">
        {MANAGER_SECTIONS.map((section) => {
          const isPending = section.status === "in-progress";
          const isCurrent = section.status === "ready" && section.href === "/manager";
          return (
            <ManagerCard
              key={section.id}
              id={section.anchor}
              title={section.label}
              description={section.summary}
              footer={
                isPending ? (
                  <>
                    <span className="sl-m-badge sl-m-badge--pending">
                      Раздел в работе
                    </span>
                    <ManagerButton disabled>Открыть раздел</ManagerButton>
                  </>
                ) : isCurrent ? (
                  <span className="sl-m-badge">Вы здесь</span>
                ) : (
                  <Link className="sl-m-button sl-m-button--primary" href={section.href}>
                    Открыть раздел
                  </Link>
                )
              }
            >
              <p className="sl-m-card__note">
                {isPending
                  ? "Раздел в работе: данные и действия появятся здесь после сборки раздела."
                  : "Раздел готов: содержимое доступно по кнопке ниже."}
              </p>
            </ManagerCard>
          );
        })}
      </div>
    </div>
  );
}
