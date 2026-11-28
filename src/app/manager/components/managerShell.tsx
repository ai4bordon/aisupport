"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import logo from "../softline-logo.png";
import { MANAGER_SECTIONS } from "./managerSections";

/**
 * Каркас кабинета менеджера: фирменная шапка с логотипом, навигация по
 * разделам и область содержимого.
 *
 * Пропсы:
 * - `children` — содержимое текущего раздела кабинета.
 *
 * Каркас отвечает за три вещи:
 * 1) логотип «Софтлайн Решения» с охранным полем не меньше высоты логотипа
 *    (правило брендбука, `var(--sl-logo-guard)`);
 * 2) навигацию по разделам кабинета — все разделы есть в меню, неготовые
 *    подписаны «в работе» и ведут на честное состояние раздела;
 * 3) семантическую разметку: `header` (шапка), `nav` (навигация), `main`
 *    (содержимое) — разделы достижимы с клавиатуры.
 *
 * Страница входа (`/manager/login`) рендерится без навигации: меню разделов
 * на экране входа только мешает.
 */
export function ManagerShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const isLogin = pathname.startsWith("/manager/login");

  return (
    <div className="sl-m-shell">
      <header className="sl-m-header">
        <div className="sl-m-brand">
          <Link className="sl-m-brand__link" href="/manager">
            <Image
              src={logo}
              alt="Софтлайн Решения"
              width={200}
              height={44}
              className="sl-m-brand__logo"
            />
          </Link>
        </div>

        {isLogin ? null : (
          <nav className="sl-m-nav" aria-label="Разделы кабинета">
            <ul className="sl-m-nav__list">
              {MANAGER_SECTIONS.map((section) => {
                const isPending = section.status === "in-progress";
                const isActive = pathname === section.href;
                return (
                  <li key={section.id} className="sl-m-nav__item">
                    <Link
                      className="sl-m-nav__link"
                      href={isPending ? `/manager#${section.anchor}` : section.href}
                      data-status={section.status}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <span className="sl-m-nav__label">{section.label}</span>
                      {isPending ? (
                        <span className="sl-m-nav__badge">в работе</span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
              {/* Журнал изменений настроек: его видно прямо в кабинете. */}
              <li className="sl-m-nav__item">
                <Link className="sl-m-nav__link" href="/manager/audit">
                  <span className="sl-m-nav__label">Аудит</span>
                </Link>
              </li>
              {/* Обратно на стенд: из кабинета уйти было некуда, кроме
                  адресной строки. Для жюри это тупик. */}
              <li className="sl-m-nav__item">
                <Link className="sl-m-nav__link sl-m-nav__link--back" href="/start">
                  <span className="sl-m-nav__label">На стенд</span>
                </Link>
              </li>
            </ul>
          </nav>
        )}
      </header>

      <main className="sl-m-main" id="sl-m-main">
        {children}
      </main>
    </div>
  );
}
