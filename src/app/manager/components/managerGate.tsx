"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Барьер доступа к кабинету менеджера.
 *
 * Пропсы:
 * - `authorized` — есть ли действующая менеджерская cookie `support_manager`
 *   (решение приходит с сервера, в браузер код менеджера не попадает);
 * - `children` — содержимое кабинета, доступное при успешном входе.
 *
 * Без менеджерской cookie содержимое не рендерится вовсе — вместо него
 * показывается требование входа. Исключение — сама страница входа
 * `/manager/login`: она доступна всегда, иначе войти было бы некуда.
 */
export function ManagerGate({
  authorized,
  children,
}: {
  authorized: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const isLogin = pathname.startsWith("/manager/login");

  if (authorized || isLogin) {
    return <>{children}</>;
  }

  return (
    <section className="sl-m-gate" aria-labelledby="sl-m-gate-title">
      <h1 className="sl-m-gate__title" id="sl-m-gate-title">
        Требуется вход менеджера
      </h1>
      <p className="sl-m-gate__text">
        Кабинет закрыт отдельным кодом менеджера. Код проверяется на сервере и
        не сохраняется в браузере: выдаётся подписанная cookie сессии
        менеджера.
      </p>
      <Link className="sl-m-gate__link" href="/manager/login">
        Войти в кабинет
      </Link>
    </section>
  );
}
