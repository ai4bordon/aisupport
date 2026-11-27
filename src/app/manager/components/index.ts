/**
 * Точка входа для переиспользуемых элементов оболочки кабинета.
 *
 * Остальные срезы UI (очередь, база знаний, агент, аналитика) импортируют
 * элементы отсюда одним адресом: `@/app/manager/components`.
 *
 * Состав:
 * - `ManagerShell` — каркас кабинета: шапка с логотипом, навигация по
 *   разделам, область содержимого;
 * - `ManagerGate` — барьер доступа: без менеджерской cookie кабинет не
 *   открывается, показывается требование входа;
 * - `ManagerCard` — карточка раздела;
 * - `ManagerTabs` — полоса вкладок (внутри одного раздела);
 * - `ManagerButton` — кнопка (в том числе выключенная: действие не готово);
 * - `ManagerLoading` — состояние загрузки;
 * - `ManagerErrorState` — состояние ошибки;
 * - `ManagerEmptyState` — пустое состояние;
 * - `MANAGER_SECTIONS` — состав разделов кабинета и их состояние.
 *
 * Пропсы каждого элемента описаны в комментарии к его модулю.
 */
export { ManagerShell } from "./managerShell";
export { ManagerGate } from "./managerGate";
export { ManagerCard } from "./managerCard";
export { ManagerTabs } from "./managerTabs";
export type { ManagerTab } from "./managerTabs";
export { ManagerButton } from "./managerButton";
export { ManagerLoading } from "./managerLoading";
export { ManagerErrorState } from "./managerErrorState";
export { ManagerEmptyState } from "./managerEmptyState";
export { MANAGER_SECTIONS } from "./managerSections";
export type { ManagerSection, ManagerSectionStatus } from "./managerSections";
