import type { Metadata } from "next";
import { AgentClient } from "./agent-client";
import { defaultSystemPrompt } from "@/modules/agent-settings";
import "./styles.css";

export const metadata: Metadata = {
  title: "Настройки агента — кабинет менеджера",
  description:
    "Кабинет менеджера: настройки агента, песочница, история тестовых сессий и аудит изменений.",
};

/**
 * Раздел кабинета менеджера «Агент» (бриф §8).
 *
 * Страница переносит готовую страницу настроек среза 08
 * (`src/app/settings/**`) в кабинет менеджера. Барьер кабинера — та же
 * подписанная cookie `support_manager`, что и у остальных маршрутов
 * менеджера: без действующей cookie содержимое не рендерится
 * (`docs/api-contract.md` §11.1, `src/app/manager/layout.tsx`).
 *
 * Данные раздела берутся из маршрутов среза 08:
 * `GET/PUT /api/settings`, `GET /api/settings/history`,
 * `POST /api/settings/sandbox` и `GET /audit`.
 */
export default function ManagerAgentPage() {
  return <AgentClient defaultPrompt={defaultSystemPrompt()} />;
}
