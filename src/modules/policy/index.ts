/**
 * Публичный API модуля полномочий.
 *
 * Наружу отдаётся только `check`; внутренние файлы модуля напрямую
 * не импортируются (docs/api-contract.md §1).
 */
export { check, requestedPercent, ruleKeyForRequest } from "./rules";
export type { PolicyDecision, PolicyRequest } from "./rules";
