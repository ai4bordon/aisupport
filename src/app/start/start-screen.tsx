"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AdminTab } from "./admin-tab";
import { BrandHeader } from "./brand-header";
import { ChatTab } from "./chat-tab";
import { MaxTab } from "./max-tab";

/**
 * Оболочка экрана демо `/start`: три вкладки и ленивая загрузка.
 *
 * Порядок вкладок утверждён владельцем: Веб-чат, MAX, Админка. Состояние
 * живёт в URL (`?tab=chat|max|admin`), поэтому ссылкой на экран можно
 * поделиться. Содержимое неактивной вкладки не монтируется: виджет, лента и
 * кабинет не тратят ресурсы, пока их не показали.
 */

/** Идентификаторы вкладок — они же значения параметра `tab` в URL. */
const TABS = [
  { id: "chat", title: "Веб-чат" },
  { id: "max", title: "MAX" },
  { id: "admin", title: "Админка" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Вкладка по идентификатору; неизвестное значение — первая вкладка. */
function tabFromParam(value: string | undefined): TabId {
  const match = TABS.find((tab) => tab.id === value);
  return match?.id ?? "chat";
}

/**
 * Экран демо.
 *
 * `initialTab` — вкладка из URL, её задаёт серверный компонент. Дальше
 * переключение живёт в адресной строке, поэтому перезагрузка и ссылка
 * сохраняют выбранную вкладку.
 */
export function StartScreen({
  initialTab,
  origin,
}: {
  initialTab: string | undefined;
  origin: string;
}) {
  const [active, setActive] = useState<TabId>(() => tabFromParam(initialTab));
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

  // Синхронизация с адресной строкой: параметр `tab` — единственный источник
  // истины для выбранной вкладки.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", active);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [active]);

  const select = useCallback((id: TabId): void => {
    setActive(id);
    tabRefs.current.get(id)?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      const index = TABS.findIndex((tab) => tab.id === active);
      let next = -1;

      if (event.key === "ArrowRight") {
        next = (index + 1) % TABS.length;
      } else if (event.key === "ArrowLeft") {
        next = (index - 1 + TABS.length) % TABS.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = TABS.length - 1;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(active);
        return;
      }

      if (next >= 0) {
        event.preventDefault();
        select(TABS[next]?.id ?? "chat");
      }
    },
    [active, select],
  );

  return (
    <div className="sl-start">
      <BrandHeader />
      <main className="sl-start__main">
        <div className="sl-start__tabs" role="tablist" aria-label="Разделы демонстрации">
          {TABS.map((tab) => (
            <button
              className="sl-start__tab"
              id={`sl-start-tab-${tab.id}`}
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === active}
              aria-controls={`sl-start-panel-${tab.id}`}
              tabIndex={tab.id === active ? 0 : -1}
              ref={(element) => {
                if (element) {
                  tabRefs.current.set(tab.id, element);
                } else {
                  tabRefs.current.delete(tab.id);
                }
              }}
              onClick={() => select(tab.id)}
              onKeyDown={onKeyDown}
            >
              {tab.title}
            </button>
          ))}
        </div>

        <div
          className="sl-start__panel"
          id={`sl-start-panel-${active}`}
          role="tabpanel"
          aria-labelledby={`sl-start-tab-${active}`}
          tabIndex={0}
          data-origin={origin}
        >
          {active === "chat" && <ChatTab />}
          {active === "max" && <MaxTab />}
          {active === "admin" && <AdminTab />}
        </div>
      </main>
    </div>
  );
}
