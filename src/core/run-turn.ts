import { runWithDialogContext } from "@/core/dialog-context";
import { runAgent } from "@/core/run";
import type { AgentOutcome, NormalizedMessage } from "@/core/run";

/**
 * Запуск агентного цикла в контексте хода диалога (R16, AC 4).
 *
 * Идентификатор сообщения хода известен на границе канала, а записывающим
 * модулям (`src/modules/telemetry/steps.ts`) он нужен как часть
 * идемпотентного ключа шага. Контекст хода задаётся здесь — на границе,
 * где известен `message_id` — и живёт в асинхронной цепочке вызовов, поэтому
 * ядро (`src/core/run.ts`) менять не нужно.
 *
 * Модуль существует отдельно от `src/core/run.ts` намеренно: ядро правит
 * другой срез, и правка границы не должна ждать его слияния.
 */

export type { AgentOutcome, NormalizedMessage };

/**
 * Запускает агентный цикл в контексте хода диалога.
 */
export async function runAgentInTurn(
  input: NormalizedMessage,
): Promise<AgentOutcome> {
  return runWithDialogContext(
    {
      conversationId: input.conversationId,
      messageId: input.messageId,
    },
    () => runAgent(input),
  );
}
