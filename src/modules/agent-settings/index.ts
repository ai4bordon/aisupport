/**
 * Публичный API модуля настроек агента.
 *
 * Наружу отдаются только перечисленные функции и типы: внутренние файлы
 * модуля напрямую не импортируются (docs/api-contract.md §1).
 *
 * Модуль владеет:
 * - хранением версионируемой конфигурации агента;
 * - реестром возможностей (честное состояние каждого элемента управления);
 * - изолированной песочницей и историей тестовых сессий;
 * - аудитом изменений настроек.
 */

export {
  readCurrentSettings,
  readSettingsVersion,
  updateSetting,
  bindDialogVersion,
  listVersions,
  readShadowMode,
  setShadowMode,
  defaultSystemPrompt,
  SettingsError,
} from "./store";
export type { AgentSettings, SettingsKey } from "./store";

export { describeCapabilities } from "./capabilities";
export type {
  CapabilityControl,
  CapabilityDescriptor,
} from "./capabilities";

export { createModelClientForSettings } from "@/core/model";

export { runSandbox, listTestSessions } from "./sandbox";
export type {
  SandboxInput,
  SandboxResult,
  SandboxSource,
  SandboxTraceStep,
  TestSessionSummary,
} from "./sandbox";

export { listAuditEntries, redactSecrets, writeAuditChange, REDACTED } from "./audit";
export type { AuditEntry } from "./audit";
