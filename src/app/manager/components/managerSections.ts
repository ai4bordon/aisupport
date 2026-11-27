/**
 * Разделы кабинета менеджера — единый источник правды для навигации и обзора.
 *
 * Раздел кабинета:
 * - `id` — устойчивый ключ раздела (используется в тестах и якорях);
 * - `label` — название в навигации и заголовок карточки обзора;
 * - `href` — маршрут раздела (`/manager/<id>`), на который ведёт пункт меню;
 * - `anchor` — якорь карточки раздела на странице обзора;
 * - `status` — состояние раздела: `ready` (раздел работает) либо `in-progress`
 *   (раздел в работе: пункт меню есть, но ведёт на честное состояние);
 * - `summary` — одна строка о том, что раздел делает.
 *
 * ВАЖНО ДЛЯ КОМАНДЫ РАЗДЕЛОВ: когда раздел готов, его статус переводится
 * в `ready`, и пункт навигации начинает вести на `href`. Пока статус
 * `in-progress`, пункт помечен «в работе» и ведёт на карточку честного
 * состояния — раздел не имитирует работу.
 */
export type ManagerSectionStatus = "ready" | "in-progress";

export type ManagerSection = {
  id: string;
  label: string;
  href: string;
  anchor: string;
  status: ManagerSectionStatus;
  summary: string;
};

/** Разделы кабинета в порядке навигации. */
export const MANAGER_SECTIONS: ManagerSection[] = [
  {
    id: "overview",
    label: "Обзор",
    href: "/manager",
    anchor: "section-overview",
    status: "ready",
    summary: "Что кабинет умеет и в каком состоянии разделы.",
  },
  {
    id: "queue",
    label: "Очередь",
    href: "/manager/queue",
    anchor: "section-queue",
    status: "in-progress",
    summary: "Обращения, которые требуют менеджера, и обещания клиенту.",
  },
  {
    id: "knowledge",
    label: "База знаний",
    href: "/manager/knowledge",
    anchor: "section-knowledge",
    status: "in-progress",
    summary: "Загруженные документы, черновики статей и их одобрение.",
  },
  {
    id: "agent",
    label: "Агент",
    href: "/manager/agent",
    anchor: "section-agent",
    status: "in-progress",
    summary: "Настройки агента: модель, инструменты, промпт, лимиты, режим тени.",
  },
  {
    id: "analytics",
    label: "Аналитика",
    href: "/manager/analytics",
    anchor: "section-analytics",
    status: "in-progress",
    summary: "Воронка обработки, автозакрытие, стоимость запроса и экономия.",
  },
  {
    id: "sandbox",
    label: "Песочница и история",
    href: "/manager/sandbox",
    anchor: "section-sandbox",
    status: "in-progress",
    summary: "Проверка агента вопросом и журнал прошлых тестов.",
  },
];
