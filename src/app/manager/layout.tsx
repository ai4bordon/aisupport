import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { checkManagerAccess } from "@/modules/access";
import { ManagerGate } from "./components/managerGate";
import { ManagerShell } from "./components/managerShell";
import "./styles.css";

/**
 * Каркас кабинета менеджера.
 *
 * Доступ открыт той же cookie `support_access`, что и чат стенда: для
 * демо один код и один вход, раздельные коды заведём позже, когда
 * стенд возьмёт заказчик (решение владельца от 28.11.2026).
 *
 * Барьер кабинета не списывает квоту запросов и диалогов: маршруты
 * кабинета читают данные, а не ведут диалог с клиентом.
 *
 * Решение барьера принимается на сервере: сам код в браузер не попадает и
 * в разметку не выводится.
 */
export default async function ManagerLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const decision = await checkManagerAccess({
    cookieHeader: cookieStore.toString(),
  });

  return (
    <ManagerShell>
      <ManagerGate authorized={decision.allowed}>{children}</ManagerGate>
    </ManagerShell>
  );
}
