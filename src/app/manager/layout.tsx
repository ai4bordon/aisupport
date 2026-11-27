import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { checkManagerAccess } from "@/modules/access";
import { ManagerGate } from "./components/managerGate";
import { ManagerShell } from "./components/managerShell";
import "./styles.css";

/**
 * Каркас кабинета менеджера.
 *
 * Доступ закрыт отдельным кодом менеджера: без действующей cookie
 * `support_manager` содержимое кабинета не рендерится — вместо него
 * показывается требование входа (`docs/api-contract.md` §11.1).
 *
 * Решение барьера принимается на сервере: сам код менеджера в браузер не
 * попадает и в разметку не выводится.
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
