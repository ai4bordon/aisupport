import { randomUUID } from "node:crypto";
import type { Source } from "@/contracts/chat";
import { getModelClient, ModelTimeoutError, ModelUnavailableError } from "@/core/model";
import { validateAnswer } from "@/core/validate";
import { search } from "@/modules/knowledge";
import { check, ruleKeyForRequest } from "@/modules/policy";
import { recordStep } from "@/modules/telemetry";
import type { AgentStep } from "@/modules/telemetry";

/**
 * Ядро агентного цикла.
 *
 * Последовательность: классификация → поиск → полномочия → генерация →
 * валидация → ответ или эскалация.
 *
 * Инварианты:
 * - в модель уходит только маскированный текст и подтверждённые источники;
 * - без подтверждённого источника — эскалация, а не выдуманный ответ;
 * - любой сбой превращается в эскалацию с соответствующей причиной;
 * - каждый узел пишет шаг в трассу.
 */

export type NormalizedMessage = {
  conversationId: string;
  messageId: string;
  channel: "web" | "max";
  externalChatId: string | null;
  text: string;
  maskedFieldsCount: number;
  /** Арендатор определён сервером и не приходит из тела запроса. */
  tenantId: string;
};

export type AgentOutcome =
  | {
      outcome: "respond";
      answer: { text: string; sources: Source[] };
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
 * Пределы времени (docs/api-contract.md §10).
 *
 * - внутренний шаг — 5 с;
 * - весь диалог — 300 с.
 *
 * Предел ожидания первого токена модели (120 с) и пауза перед повтором
 * после 429 (30 с) заданы в src/core/model.ts.
 */
export const STEP_TIMEOUT_MS = 5_000;
export const DIALOG_TIMEOUT_MS = 300_000;

const SYSTEM_PROMPT = [
  "Ты — агент службы поддержки ПАО «Софтлайн».",
  "Отвечай только по подтверждённым источникам, которые переданы тебе.",
  "Если источников нет, так и скажи: подтверждённого ответа нет.",
  "Не выдумывай суммы, условия и факты.",
  "Персональные данные в запросе заменены метками вида ⟦PERSON_1⟧ —",
  "используй метки как есть и не пытайся их раскрыть.",
  "Ответ верни в JSON: {\"text\": string, \"amounts\": number[], \"citations\": string[]}.",
].join(" ");

function nowMs(): number {
  return Date.now();
}

/** Замер длительности узла в миллисекундах. */
function elapsedSince(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
}

/**
 * Предел времени для внутреннего шага (5 с) и всего диалога (300 с).
 *
 * Истечение любого из пределов — эскалация с причиной `upstream_timeout`,
 * а не ответ по памяти модели.
 */
class TimeoutGuard {
  readonly deadline: number;

  constructor(private readonly dialogStartedAt: number) {
    this.deadline = dialogStartedAt + DIALOG_TIMEOUT_MS;
  }

  /** Остаток времени на шаг с учётом общего предела диалога. */
  stepBudget(): number {
    const dialogLeft = this.deadline - nowMs();
    return Math.max(0, Math.min(STEP_TIMEOUT_MS, dialogLeft));
  }

  get dialogExpired(): boolean {
    return nowMs() >= this.deadline;
  }
}

/**
 * Ошибка превышения времени ожидания внутреннего шага.
 */
export class StepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepTimeoutError";
  }
}

/**
 * Запуск шага с пределом времени.
 *
 * Промис задачи не отменяется — он продолжает выполняться, но его результат
 * уже не используется. Для сетевых вызовов предел держит сам клиент модели.
 */
async function withStepTimeout<T>(
  budgetMs: number,
  operation: () => Promise<T>,
  node: string,
): Promise<T> {
  if (budgetMs <= 0) {
    throw new StepTimeoutError(`Предел времени диалога истёк до узла ${node}`);
  }

  const { promise, resolve, reject } = withResolvers<T>();
  const timer = setTimeout(() => {
    reject(new StepTimeoutError(`Узел ${node} превысил предел времени ${budgetMs} мс`));
  }, budgetMs);

  operation().then(resolve, reject);

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

/** `Promise.withResolvers` требует lib ES2024, а проект зафиксирован на ES2023. */
function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Классификация вопроса по таксономии намерений.
 *
 * Классификатор использует ту же модель коротким промптом (R16).
 */
async function classify(
  input: NormalizedMessage,
): Promise<{ intent: string; tokensIn: number; tokensOut: number; costRub: number; model: string }> {
  const client = getModelClient();
  const result = await client.complete({
    messages: [
      {
        role: "system",
        content:
          "Определи намерение клиента по базе знаний. Ответь одним словом: код намерения.",
      },
      { role: "user", content: input.text },
    ],
    maxTokens: 32,
  });
  return {
    intent: result.text.trim(),
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costRub: result.costRub,
    model: result.model,
  };
}

function escalationOutcome(
  reason: string,
  summary: string,
  draft: string | null,
  steps: AgentStep[],
): AgentOutcome {
  return {
    outcome: "escalate",
    answer: null,
    escalation: { id: randomUUID(), reason, summary, draft },
    steps,
  };
}

/**
 * Запуск агентного цикла для нормализованного сообщения.
 */
export async function runAgent(input: NormalizedMessage): Promise<AgentOutcome> {
  const steps: AgentStep[] = [];
  const tenantId = input.tenantId;
  const guard = new TimeoutGuard(nowMs());

  const pushStep = async (
    step: Omit<AgentStep, "conversationId">,
  ): Promise<void> => {
    const full: AgentStep = { ...step, conversationId: input.conversationId };
    steps.push(full);
    try {
      await recordStep(full, tenantId);
    } catch {
      // Трасса не должна ломать ответ клиенту: сбой записи не отменяет ответ.
    }
  };

  // Узел 1: классификация.
  const classifyStartedAt = nowMs();
  let intent = "";
  try {
    const classification = await withStepTimeout(
      guard.stepBudget(),
      () => classify(input),
      "classify",
    );
    intent = classification.intent;
    await pushStep({
      node: "classify",
      endpoint: "POST /agent/classify",
      tokensIn: classification.tokensIn,
      tokensOut: classification.tokensOut,
      costRub: classification.costRub,
      latencyMs: elapsedSince(classifyStartedAt),
      metadata: { intent },
      sourceIds: [],
      outcome: null,
      model: classification.model,
    });
  } catch (error) {
    const reason =
      error instanceof ModelTimeoutError || error instanceof StepTimeoutError
        ? "upstream_timeout"
        : "upstream_error";
    await pushStep({
      node: "classify",
      endpoint: "POST /agent/classify",
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: elapsedSince(classifyStartedAt),
      metadata: { error: reason },
      sourceIds: [],
      outcome: "escalate",
      model: null,
    });
    return escalationOutcome(
      reason,
      "Не удалось классифицировать обращение — передаём менеджеру.",
      null,
      steps,
    );
  }

  // Узел 2: поиск по одобренной БЗ.
  const retrieveStartedAt = nowMs();
  let sources: Source[] = [];
  try {
    const results = await withStepTimeout(
      guard.stepBudget(),
      () => search(input.text, tenantId),
      "retrieve",
    );
    sources = results.map((result) => ({
      kind: result.articleId ? ("kb_article" as const) : ("kb_document" as const),
      id: result.articleId,
      title: result.title,
      location: result.location,
      text: result.text,
    }));
    await pushStep({
      node: "retrieve",
      endpoint: "GET /kb/search",
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: elapsedSince(retrieveStartedAt),
      metadata: { matches: sources.length },
      sourceIds: sources.map((source) => source.id),
      outcome: null,
      model: null,
    });
  } catch (error) {
    const reason =
      error instanceof ModelTimeoutError || error instanceof StepTimeoutError
        ? "upstream_timeout"
        : "upstream_error";
    await pushStep({
      node: "retrieve",
      endpoint: "GET /kb/search",
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: elapsedSince(retrieveStartedAt),
      metadata: { error: reason },
      sourceIds: [],
      outcome: "escalate",
      model: null,
    });
    return escalationOutcome(
      reason,
      "Поиск по базе знаний недоступен — передаём менеджеру.",
      null,
      steps,
    );
  }

  // Нет подтверждённого источника — эскалация, а не ответ по памяти модели.
  if (sources.length === 0) {
    await pushStep({
      node: "escalate",
      endpoint: null,
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: 0,
      metadata: { reason: "no_confirmed_source" },
      sourceIds: [],
      outcome: "escalate",
      model: null,
    });
    return escalationOutcome(
      "no_confirmed_source",
      `В базе знаний нет опубликованного источника по запросу клиента.`,
      null,
      steps,
    );
  }

  // Узел 3: проверка полномочий.
  const policyStartedAt = nowMs();
  const ruleKey = ruleKeyForRequest(input.text);
  let policyAllowed = true;
  let policyReason: string | null = null;
  if (ruleKey) {
    try {
      const decision = await check({ text: input.text, ruleKey }, tenantId);
      policyAllowed = decision.allowed;
      policyReason = decision.reason;
    } catch {
      policyAllowed = false;
      policyReason = "Проверка полномочий недоступна.";
    }
  }
  await pushStep({
    node: "policy",
    endpoint: "POST /policy/check",
    tokensIn: 0,
    tokensOut: 0,
    costRub: 0,
    latencyMs: elapsedSince(policyStartedAt),
    metadata: { ruleKey, allowed: policyAllowed },
    sourceIds: [],
    outcome: policyAllowed ? null : "escalate",
    model: null,
  });

  if (!policyAllowed) {
    await pushStep({
      node: "escalate",
      endpoint: null,
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: 0,
      metadata: { reason: "policy_denied" },
      sourceIds: sources.map((source) => source.id),
      outcome: "escalate",
      model: null,
    });
    return escalationOutcome(
      "policy_denied",
      policyReason ?? "Условия вне полномочий агента — передаём менеджеру.",
      null,
      steps,
    );
  }

  // Узел 4: генерация ответа. В модель уходят только метки и источники.
  const respondStartedAt = nowMs();
  let generatedText = "";
  let generatedAmounts: number[] = [];
  let generatedCitations: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costRub = 0;
  let model: string | null = null;

  try {
    const client = getModelClient();
    // Шаг генерации ограничен 5 с и общим пределом диалога 300 с.
    const result = await withStepTimeout(
      guard.stepBudget(),
      () =>
        client.complete({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: input.text },
            {
              role: "assistant",
              content: `Подтверждённые источники:\n${sources
                .map(
                  (source, index) =>
                    `[${index + 1}] ${source.title}${source.location ? ` (${source.location})` : ""}\n${source.text}`,
                )
                .join("\n\n")}`,
            },
          ],
        }),
      "respond",
    );
    generatedText = result.text;
    generatedAmounts = result.amounts;
    generatedCitations = result.citations;
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;
    costRub = result.costRub;
    model = result.model;

    await pushStep({
      node: "respond",
      endpoint: "POST /agent/respond",
      tokensIn,
      tokensOut,
      costRub,
      latencyMs: elapsedSince(respondStartedAt),
      metadata: { intent },
      sourceIds: sources.map((source) => source.id),
      outcome: null,
      model,
    });
  } catch (error) {
    const reason =
      error instanceof ModelTimeoutError || error instanceof StepTimeoutError
        ? "upstream_timeout"
        : "upstream_error";
    await pushStep({
      node: "respond",
      endpoint: "POST /agent/respond",
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: elapsedSince(respondStartedAt),
      metadata: { error: reason },
      sourceIds: sources.map((source) => source.id),
      outcome: "escalate",
      model: null,
    });
    return escalationOutcome(
      reason,
      "Модель недоступна — передаём менеджеру.",
      null,
      steps,
    );
  }

  // Узел 5: валидация ответа.
  const validateStartedAt = nowMs();
  const validation = validateAnswer(
    { text: generatedText, amounts: generatedAmounts, citations: generatedCitations },
    sources,
  );
  await pushStep({
    node: "validate",
    endpoint: null,
    tokensIn: 0,
    tokensOut: 0,
    costRub: 0,
    latencyMs: elapsedSince(validateStartedAt),
    metadata: { valid: validation.valid, violations: validation.violations.map((v) => v.code) },
    sourceIds: sources.map((source) => source.id),
    outcome: validation.valid ? null : "escalate",
    model,
  });

  if (!validation.valid) {
    await pushStep({
      node: "escalate",
      endpoint: null,
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: 0,
      metadata: { reason: "validation_failed" },
      sourceIds: sources.map((source) => source.id),
      outcome: "escalate",
      model,
    });
    return escalationOutcome(
      "validation_failed",
      "Ответ не прошёл проверку по источникам и персональным данным — передаём менеджеру.",
      null,
      steps,
    );
  }

  await pushStep({
    node: "respond",
    endpoint: "POST /agent/respond",
    tokensIn: 0,
    tokensOut: 0,
    costRub: 0,
    latencyMs: 0,
    metadata: { delivered: true },
    sourceIds: sources.map((source) => source.id),
    outcome: "respond",
    model,
  });

  return {
    outcome: "respond",
    answer: { text: generatedText, sources },
    escalation: null,
    steps,
  };
}
