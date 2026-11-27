"use client";

import Link from "next/link";
import { useRef } from "react";

/**
 * Вкладка оболочки кабинета.
 *
 * Пропсы:
 * - `id` — ключ вкладки (совпадает с `id` раздела кабинета);
 * - `label` — название вкладки;
 * - `href` — адрес, если вкладка ведёт на другой маршрут;
 * - `badge` — короткая подпись рядом с названием (например, «в работе»);
 * - `active` — вкладка открыта сейчас;
 * - `disabled` — вкладка выключена: недоступна с клавиатуры и подписана.
 *
 * Вкладка с `href` рендерится ссылкой и работает без JavaScript; вкладка без
 * `href` — кнопкой, её выбор обрабатывает вызывающий код через `onSelect`.
 */
export type ManagerTab = {
  id: string;
  label: string;
  href?: string;
  badge?: string;
  active?: boolean;
  disabled?: boolean;
};

/**
 * Полоса вкладок кабинета.
 *
 * Пропсы:
 * - `tabs` — список вкладок;
 * - `activeId` — ключ открытой вкладки;
 * - `label` — доступное имя полосы вкладок;
 * - `onSelect` — выбор вкладки без адреса.
 *
 * Доступность: полоса объявлена как `tablist`, вкладки — как `tab`;
 * стрелки влево/вправо переключают вкладку, `Home`/`End` — крайние.
 */
export function ManagerTabs({
  tabs,
  activeId,
  label,
  onSelect,
}: {
  tabs: ManagerTab[];
  activeId: string;
  label: string;
  onSelect?: (id: string) => void;
}) {
  const refs = useRef<Array<HTMLAnchorElement | HTMLButtonElement | null>>([]);

  function moveFocus(from: number, step: number) {
    const count = tabs.length;
    if (count === 0) {
      return;
    }
    let next = from;
    for (let attempt = 0; attempt < count; attempt += 1) {
      next = (next + step + count) % count;
      const tab = tabs[next];
      if (tab && !tab.disabled) {
        refs.current[next]?.focus();
        return;
      }
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus(index, 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(index, -1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0, 1);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      moveFocus(tabs.length - 1, -1);
    }
  }

  return (
    <div className="sl-m-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => {
        const isActive = tab.active ?? tab.id === activeId;
        const common = {
          role: "tab" as const,
          "aria-selected": isActive,
          "aria-disabled": tab.disabled ? true : undefined,
          tabIndex: isActive && !tab.disabled ? 0 : -1,
          "data-status": tab.disabled ? "in-progress" : "ready",
          onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => onKeyDown(event, index),
          ref: (node: HTMLAnchorElement | HTMLButtonElement | null) => {
            refs.current[index] = node;
          },
        };

        const content = (
          <>
            <span className="sl-m-tabs__label">{tab.label}</span>
            {tab.badge ? <span className="sl-m-tabs__badge">{tab.badge}</span> : null}
          </>
        );

        return (
          <span className="sl-m-tabs__item" key={tab.id}>
            {/* Выключенная вкладка не ведёт никуда: ссылка без адреса и
                кнопка `disabled` одинаково недоступны с клавиатуры. */}
            {tab.href && !tab.disabled ? (
              <Link className="sl-m-tabs__tab" href={tab.href} {...common}>
                {content}
              </Link>
            ) : (
              <button
                className="sl-m-tabs__tab"
                type="button"
                disabled={tab.disabled}
                onClick={() => onSelect?.(tab.id)}
                {...common}
              >
                {content}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
