import { randomUUID } from "node:crypto";
import type { Source } from "@/contracts/chat";
import { getModelClient, ModelTimeoutError, ModelUnavailableError } from "@/core/model";
import {
  catalogAnswer,
  catalogMatchText,
  catalogSummary,
  extractSlots,
  lookupCatalog,
  SLOT_QUESTIONS,
  type CatalogLookup,
  type RequirementSlots,
} from "@/core/catalog-lookup";
import { loadSlots, saveSlots } from "@/core/slots";
import { smallTalkAnswer } from "@/core/small-talk";
import { escalationMode, noSourceAnswer } from "@/core/escalation-mode";
import { validateAnswer } from "@/core/validate";
import { currentEmbeddingProvider, search } from "@/modules/knowledge";
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
/** Предел ожидания первого токена модели (бриф §6). */
export const MODEL_CALL_TIMEOUT_MS = 120_000;
/** Предел поиска по каталогу: 136 тысяч позиций снимка фида. */
export const CATALOG_CALL_TIMEOUT_MS = 30_000;
export const DIALOG_TIMEOUT_MS = 300_000;

const SYSTEM_PROMPT = [
  "Ты — агент службы поддержки ПАО «Софтлайн».",
  "Отвечай только по подтверждённым источникам, которые переданы тебе.",
  "Если источников нет, так и скажи: подтверждённого ответа нет.",
  "Не выдумывай суммы, условия и факты.",
  "Персональные данные в запросе заменены метками вида ⟦PERSON_1⟧ —",
  "используй метки как есть и не пытайся их раскрыть.",
  "Ответ верни в JSON: {\"text\": string, \"amounts\": number[], \"citations\": string[]}.",
  "В поле citations помещай дословные фрагменты текста подтверждённых источников,",
  "без ссылок, названий статей и пересказа: только то, что есть в тексте источника.",
  "В поле amounts — только числа, которые дословно встречаются в тексте источников.",
  // Формат ответа — ADR-0014.
  "ФОРМАТ ОТВЕТА: не более 120 слов.",
  "Первый абзац — прямой ответ в одном-двух предложениях.",
  "Дальше, если нужен порядок действий, — нумерованные шаги, одно действие на шаг.",
  "В конце — ссылка на источник.",
  "Не повторяй вопрос клиента и не пиши воду.",
  "Абзац не длиннее трёх строк.",
  "Переносы строк в text сохраняй: каждый шаг с новой строки.",
].join(" ");

function nowMs(): number {
  return Date.now();
}

/** Текст ошибки для трассы: без стека и без секретов. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Замер длительности узла в миллисекундах. */
function elapsedSince(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
}

/**
 * Предел времени для внутреннего шага (5 с), вызова модели (120 с) и всего
 * диалога (300 с).
 *
 * Истечение любого из пределов — эскалация с причиной `upstream_timeout`,
 * а не ответ по памяти модели.
 *
 * Предел шага в 5 с относится к внутренним операциям (поиск по БЗ, сбор
 * источников), а не к вызову LLM: бриф даёт модели отдельный предел 120 с
 * до первого токена. Раньше к вызову модели применялся пятисекундный лимит
 * шага, и живой ответ DeepSeek (5–7 с) обрывался таймаутом.
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

  /** Остаток времени на вызов модели с учётом общего предела диалога. */
  modelBudget(): number {
    const dialogLeft = this.deadline - nowMs();
    return Math.max(0, Math.min(MODEL_CALL_TIMEOUT_MS, dialogLeft));
  }

  /**
   * Остаток времени на поиск по каталогу.
   *
   * Каталог — 136 тысяч позиций снимка фида, и полнотекстовый запрос занимает
   * больше пяти секунд: лимит внутреннего шага к нему неприменим.
   */
  catalogBudget(): number {
    const dialogLeft = this.deadline - nowMs();
    return Math.max(0, Math.min(CATALOG_CALL_TIMEOUT_MS, dialogLeft));
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
    sessionId: input.conversationId,
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

  // Узел 0: начало диалога. Приветствие и вопрос о возможностях не требуют
  // подтверждённого источника, поэтому обрабатываются до поиска по БЗ: иначе
  // они уходили в эскалацию без ответа клиенту.
  const greeting = smallTalkAnswer(input.text);
  if (greeting !== null) {
    await pushStep({
      node: "greeting",
      endpoint: null,
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: 0,
      metadata: { kind: "small_talk" },
      sourceIds: [],
      outcome: "respond",
      model: null,
    });
    return {
      outcome: "respond",
      answer: { text: greeting, sources: [] },
      escalation: null,
      steps,
    };
  }

  // Узел 1: классификация.
  const classifyStartedAt = nowMs();
  let intent = "";
  try {
    const classification = await withStepTimeout(
      guard.modelBudget(),
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
      // Причина ошибки в трассе: без неё сбой провайдера неотличим от
      // таймаута и диагностика живого стенда упирается в догадки.
      metadata: {
        error: reason,
        detail: error instanceof Error ? error.message : String(error),
      },
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

  // Узел 2: поиск по каталогу продуктов (R1a, R1b).
  //
  // Каталог — снимок фида заказчика. Здесь выясняется, назвал ли клиент
  // продукт, какие данные ещё нужны для подбора и что показать в ответе.
  const catalogStartedAt = nowMs();
  let catalogResult: CatalogLookup | null = null;
  let slots: RequirementSlots = {
    quantity: null,
    termMonths: null,
    deployment: null,
    vendor: null,
    productQuery: null,
  };
  try {
    slots = await loadSlots(input.conversationId);
    const fromText = extractSlots(input.text);
    slots = {
      quantity: slots.quantity ?? fromText.quantity,
      termMonths: slots.termMonths ?? fromText.termMonths,
      deployment: slots.deployment ?? fromText.deployment,
      vendor: slots.vendor ?? fromText.vendor,
      productQuery: slots.productQuery ?? fromText.productQuery,
    };
    await saveSlots(input.conversationId, slots);

    // Каталог ищет по 136 тысячам позиций снимка фида: полнотекстовый
    // запрос занимает больше пяти секунд, поэтому узлу каталога отведён
    // отдельный предел, а не лимит внутреннего шага.
    catalogResult = await withStepTimeout(
      guard.catalogBudget(),
      () => lookupCatalog(input.text, slots, { tenantId }),
      "catalog",
    );
    // Название продукта сохраняется в диалоге: ответ на уточняющий вопрос
    // названия не содержит, и без сохранённого названия следующий поиск по
    // каталогу ничего бы не нашёл. Сохраняется только то, что каталог
    // действительно нашёл: обычное слово названием продукта быть не может.
    if (
      catalogResult.matches.length > 0 &&
      catalogResult.productQuery !== null &&
      slots.productQuery === null
    ) {
      slots = { ...slots, productQuery: catalogResult.productQuery };
      await saveSlots(input.conversationId, slots);
    }
    await pushStep({
      node: "catalog",
      endpoint: "GET /catalog/search",
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: elapsedSince(catalogStartedAt),
      metadata: {
        productQuery: catalogResult.productQuery,
        matches: catalogResult.matches.length,
        missingSlots: catalogResult.missingSlots,
      },
      sourceIds: [],
      outcome: null,
      model: null,
    });
  } catch (error) {
    await pushStep({
      node: "catalog",
      endpoint: "GET /catalog/search",
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: elapsedSince(catalogStartedAt),
      metadata: { error: describeError(error).split("\n")[0] },
      sourceIds: [],
      outcome: "escalate",
      model: null,
    });
    // Сбой каталога не блокирует ответ по базе знаний: клиент всё равно
    // получает помощь по тем вопросам, на которые в базе есть ответ.
    catalogResult = null;
  }

  // Узел 3: поиск по одобренной БЗ.
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
      // Модель эмбеддинга в трассе: по ней видно, каким провайдером построен
      // вектор запроса, и совпадает ли он с моделью индекса.
      metadata: { matches: sources.length, embeddingModel: currentEmbeddingProvider().model },
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

  // Каталог дал позиции: клиент назвал продукт (R1a) или описывает задачу
  // (R1b). Ответ строится кодом по карточке — цена из снимка фида, а не из
  // ответа модели.
  if (catalogResult !== null && catalogResult.matches.length > 0) {
    const catalogSources = catalogResult.matches.map((match) => ({
      kind: "catalog_product" as const,
      id: match.offerId,
      title: match.name,
      location: match.url,
      text: catalogMatchText(match),
    }));

    // Данных для подбора не хватает — задаём один уточняющий вопрос.
    if (catalogResult.missingSlots.length > 0) {
      const slot = catalogResult.missingSlots[0];
      if (slot !== undefined) {
        await pushStep({
          node: "clarify",
          endpoint: null,
          tokensIn: 0,
          tokensOut: 0,
          costRub: 0,
          latencyMs: 0,
          metadata: { slot, asked: 1 },
          sourceIds: catalogSources.map((source) => source.id),
          outcome: "respond",
          model: null,
        });
        return {
          outcome: "respond",
          answer: {
            text: `${SLOT_QUESTIONS[slot]}\n\n${catalogSummary(catalogResult.matches)}`,
            sources: catalogSources,
          },
          escalation: null,
          steps,
        };
      }
    }

    // Данных достаточно: показываем позиции с ценой из снимка фида.
    await pushStep({
      node: "catalog_answer",
      endpoint: null,
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: 0,
      metadata: { matches: catalogResult.matches.length },
      sourceIds: catalogSources.map((source) => source.id),
      outcome: "respond",
      model: null,
    });
    return {
      outcome: "respond",
      answer: {
        text: catalogAnswer(catalogResult.matches, catalogResult.productQuery),
        sources: catalogSources,
      },
      escalation: null,
      steps,
    };
  }

  // Нет подтверждённого источника. В режиме `off` агент отвечает честно и
  // уточняет вопрос: неподтверждённых фактов не выдумывается, очередь
  // менеджера не создаётся. В режимах `notice` и `on` — эскалация.
  if (sources.length === 0) {
    const mode = escalationMode();
    if (mode === "off") {
      await pushStep({
        node: "no_source",
        endpoint: null,
        tokensIn: 0,
        tokensOut: 0,
        costRub: 0,
        latencyMs: 0,
        metadata: { reason: "no_confirmed_source", escalationMode: mode },
        sourceIds: [],
        outcome: "respond",
        model: null,
      });
      return {
        outcome: "respond",
        answer: { text: noSourceAnswer(), sources: [] },
        escalation: null,
        steps,
      };
    }
    await pushStep({
      node: "escalate",
      endpoint: null,
      tokensIn: 0,
      tokensOut: 0,
      costRub: 0,
      latencyMs: 0,
      metadata: { reason: "no_confirmed_source", escalationMode: mode },
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
    // Вызов модели ограничен 120 с (предел до первого токена по брифу §6)
    // и общим пределом диалога 300 с.
    const result = await withStepTimeout(
      guard.modelBudget(),
      () =>
        client.complete({
          sessionId: input.conversationId,
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
    metadata: {
      valid: validation.valid,
      violations: validation.violations.map((violation) => violation.code),
      // Детали нарушений: по одним кодам нельзя понять, что именно модель
      // вернула и почему ответ не отправлен клиенту.
      details: validation.violations.map((violation) => violation.detail),
    },
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
