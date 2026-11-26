/**
 * Публичный API канала MAX.
 *
 * Внутренние файлы канала не импортируются вне `src/channels/max/**`:
 * наружу срез отдаёт только нормализацию и, начиная с задачи 2, управление
 * адаптером.
 */
export { normalizeMaxUpdate } from "./normalize";
export type { NormalizeOptions } from "./normalize";

export type {
  AgentOutcome,
  AgentSource,
  AgentStep,
  MaskPort,
  MaskResult,
  MaxStatus,
  MaxUpdate,
  NormalizedMessage,
  RestorePort,
} from "./types";
