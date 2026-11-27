import { randomUUID } from "node:crypto";
import { withDialogLock } from "@/core/dialog-lock";
import { nextStepKey } from "@/core/dialog-context";

/**
 * Запись шага агентного цикла в трассу (R5).
 *
 * В трассу попадают только безопасные идентификаторы опубликованных
 * источников, метрики вызова и результат узла. Секреты и исходные
 * персональные данные сюда не записываются.
 *
 * Запись идёт под блокировкой диалога: два параллельных хода одного
 * диалога не должны повредить состояние друг друга.
 *
 * Ключ шага (`step_key`) связывает шаг с идемпотентным ключом хода, поэтому
 * повторная доставка того же хода не создаёт второй шаг. Ключ берётся из
 * контекста хода (`src/core/dialog-context.ts`), который задаёт граница
 * канала: без контекста шаг получает уникальный ключ и не теряется.
 */

export type AgentStep = {
  conversationId: string;
  node: string;
  endpoint: string | null;
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  latencyMs: number;
  metadata: Record<string, unknown>;
  sourceIds: string[];
  outcome: "respond" | "escalate" | null;
  model: string | null;
};

export async function recordStep(
  step: AgentStep,
  tenantId: string,
): Promise<void> {
  const stepKey = nextStepKey(step.node) ?? randomUUID();
  await withDialogLock(step.conversationId, async (client) => {
    await client.query(
      `
    INSERT INTO agent_steps (
      tenant_id, conversation_id, node, endpoint,
      tokens_in, tokens_out, cost_rub, latency_ms,
      metadata, source_ids, outcome, model, step_key
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (tenant_id, conversation_id, step_key) DO NOTHING
    `,
      [
        tenantId,
        step.conversationId,
        step.node,
        step.endpoint,
        step.tokensIn,
        step.tokensOut,
        step.costRub,
        step.latencyMs,
        JSON.stringify(step.metadata),
        JSON.stringify(step.sourceIds),
        step.outcome,
        step.model,
        stepKey,
      ],
    );
  });
}
