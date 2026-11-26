/**
 * Публичный API модуля телеметрии.
 *
 * Наружу отдаётся только `recordStep`; внутренние файлы модуля напрямую
 * не импортируются (docs/api-contract.md §1).
 */
export { recordStep } from "./steps";
export type { AgentStep } from "./steps";
