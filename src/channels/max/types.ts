import type { Update } from "@maxhub/max-bot-api/types";

/**
 * Порты среза MAX.
 *
 * Структуры повторяют замороженный контракт `docs/api-contract.md` §0.3 и §5
 * дословно: срез не импортирует код ядра и не меняет контракт.
 */

/** Событие Bot API MAX (`GET /updates`). */
export type MaxUpdate = Update;

/** Нейтральный вход ядра — `docs/api-contract.md` §0.3. */
export type NormalizedMessage = {
  conversationId: string;
  messageId: string;
  channel: "web" | "max";
  externalChatId: string | null;
  text: string;
  maskedFieldsCount: number;
};

/** Источник ответа — формат `docs/api-contract.md` §4. */
export type AgentSource = {
  kind: string;
  id: string;
  title: string;
  location?: string | null;
};

/** Шаг трассы — формат `docs/api-contract.md` §5. */
export type AgentStep = {
  node: string;
  endpoint?: string | null;
  duration_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_rub?: number;
  source_ids?: string[];
  outcome?: string | null;
  model?: string | null;
};

/** Результат ядра — `docs/api-contract.md` §0.3. */
export type AgentOutcome =
  | {
      outcome: "respond";
      answer: { text: string; sources: AgentSource[] };
      escalation: null;
      steps: AgentStep[];
    }
  | {
      outcome: "escalate";
      answer: null;
      escalation: {
        id: string;
        reason: string;
        summary: string;
        draft: string | null;
      };
      steps: AgentStep[];
    };

/**
 * Порт маскирования ядра. Правила ПД живут в ядре (`src/core/mask.ts`),
 * срез правила не дублирует, а вызывает порт.
 *
 * Диалог передаётся, чтобы таблица соответствий меток накапливалась по
 * диалогу: одно и то же исходное значение в разных диалогах получает
 * независимые метки, а восстановление по метке остаётся однозначным.
 *
 * Порт асинхронный: накопленные метки лежат в базе, и маскирование должно
 * знать их до замены значения, иначе один и тот же человек получил бы в
 * двух сообщениях разные метки.
 */
export type MaskResult = {
  maskedText: string;
  maskedFieldsCount: number;
};

export type MaskPort = (
  text: string,
  conversationId: string,
) => MaskResult | Promise<MaskResult>;

/**
 * Порт восстановления меток ПД в ответе. Ядро по контракту отдаёт ответ
 * с метками (`docs/api-contract.md` §5), поэтому канал восстанавливает их
 * перед отправкой клиенту. Ядро среза 01 ещё не слито — порт подключает exec
 * в волне 2; без порта текст уходит клиенту как есть.
 */
export type RestorePort = (
  text: string,
  conversationId: string,
) => string | Promise<string>;

/** Состояние подключения канала — `docs/api-contract.md` §0.3 (MaxStatus). */
export type MaxStatus = {
  running: boolean;
  lastEventAt: string | null;
  lastMarker: number | null;
  shadowMode: boolean;
};
