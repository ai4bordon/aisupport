/**
 * Публичный API канала MAX.
 *
 * Внутренние файлы канала не импортируются вне `src/channels/max/**`:
 * наружу срез отдаёт нормализацию и управление адаптером.
 */
export { normalizeMaxUpdate } from "./normalize";
export type { NormalizeOptions } from "./normalize";

export {
  createMaxSession,
  getMaxStatus,
  handleMaxUpdate,
  handleMaxUpdates,
  rateLimitDelay,
  startMaxAdapter,
  stopMaxAdapter,
} from "./adapter";
export type {
  MaxAdapterOptions,
  MaxChannelState,
  MaxChannelStateStore,
  MaxClock,
  MaxLogger,
  MaxSession,
} from "./adapter";

export { createMaxClient } from "./client";
export type { MaxClient, MaxClientOptions } from "./client";

export { createMessageRecorder, deterministicUuid } from "./messages";
export type { MessageRecordPort, MessagePoolLike, RecordedMessage } from "./messages";

export { createCoreClient, toAgentRunRequest } from "./core";
export type { AgentRunRequest, CoreClientOptions } from "./core";

export { createChannelStateStore, createStatePool } from "./state";
export type { PoolLike } from "./state";

export type {
  AgentOutcome,
  AgentSource,
  AgentStep,
  MaskPort,
  MaskResult,
  MaxStatus,
  MaxUpdate,
  NormalizedMessage,
  OutgoingCheckPort,
  RestorePort,
  ShadowQueuePort,
  ShadowQueueRecord,
} from "./types";
