import { randomUUID } from "node:crypto";
import { maskPersonalData } from "@/core/mask";
import { validateAnswer } from "@/core/validate";
import { search } from "@/modules/knowledge";
import { getPool } from "@/db/pool";
import {
  createModelClientForSettings,
  getModelClient,
  hasModelClientOverride,
  type ModelClient,
} from "@/core/model";
import { readCurrentSettings, readSettingsVersion, type AgentSettings } from "./store";

/**
 * Песочница настроек агента (docs/plans/08-agent-settings-sandbox.md, шаг 4).
 *
 * Инварианты:
 * - песочница не вызывает `runAgent` и не пишет в `agent_steps`, `messages`,
 *   `conversations`, `escalations`, `promises`: рабочее окружение и его
 *   аналитика не видят тестовой сессии;
 * - внешние каналы (веб-чат, MAX) песочница не вызывает вовсе;
 * - результат возвращается только менеджеру и пишется только в
 *   `agent_test_sessions`;
 * - обещаний клиенту песочница не создаёт: результат не уходит в клиентский
 *   интерфейс.
 */

/** Шаг собственной трассы песочницы: в `agent_steps` она не попадает. */
export type SandboxTraceStep = {
  node: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  detail: string | null;
};

export type SandboxSource = {
  kind: string;
  id: string;
  title: string;
  location: string | null;
};

/**
 * Источник с текстом: текст нужен валидатору для проверки цитат.
 */
type SandboxSourceWithText = SandboxSource & { text: string };

export type SandboxResult = {
  /** Идентификатор тестовой сессии: свой у каждой сессии. */
  sessionId: string;
  /** Версия конфигурации, на которой считалась сессия. */
  settingsVersion: number;
  outcome: "respond" | "escalate";
  /** Оценка результата: `ok`, `no_confirmed_source` или `invalid`. */
  grade: "ok" | "no_confirmed_source" | "invalid";
  answer: string;
  sources: SandboxSource[];
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  /** Собственная трасса песочницы. */
  trace: SandboxTraceStep[];
};

export type SandboxInput = {
  tenantId: string;
  /** Субъект запуска: менеджер. */
  actor: string;
  /** Текст вопроса менеджера. */
  text: string;
  /** Версия конфигурации: по умолчанию текущая. */
  settingsVersion?: number;
};

/**
 * Пределы контекста источников в песочнице.
 *
 * Свои значения, а не общие с ядром: песочница — отдельный проход, и её
 * контекст не должен зависеть от внутреннего оформления ядра. Промпт
 * песочницы собирается здесь же.
 */
const MAX_PROMPT_SOURCES = 3;
const MAX_SOURCE_CHARS = 600;

/** Текст источников для промпта песочницы. */
function buildSandboxSourceContext(sources: SandboxSourceWithText[]): string {
  const parts: string[] = [];
  for (const [index, source] of sources.slice(0, MAX_PROMPT_SOURCES).entries()) {
    const text = source.text.slice(0, MAX_SOURCE_CHARS);
    parts.push(
      `[${index + 1}] ${source.title}${source.location ? ` (${source.location})` : ""}\n${text}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Клиент модели песочницы.
 *
 * Порядок: клиент, подставленный на границе (`setModelClient` из
 * `src/core/model.ts`) — он же тестовый seam; иначе клиент, собранный по
 * сохранённой конфигурации. Второй вариант и есть проверка настроек:
 * песочница считает ответ той же конфигурацией, которую менеджер настроил.
 */
function resolveClient(settings: AgentSettings): ModelClient {
  if (hasModelClientOverride()) {
    return getModelClient();
  }
  return createModelClientForSettings({
    provider: settings.provider,
    model: settings.model,
    endpoint: settings.endpoint,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    systemPrompt: settings.systemPrompt,
  });
}

/**
 * Изолированный тестовый проход по сохранённой конфигурации.
 *
 * Песочница собирает собственный проход: маскирование входа, поиск
 * источников, вызов модели, проверка ответа. Ядро не вызывается, поэтому
 * трасса рабочего окружения не меняется.
 */
export async function runSandbox(input: SandboxInput): Promise<SandboxResult> {
  const trace: SandboxTraceStep[] = [];
  const sessionId = randomUUID();

  const settings =
    input.settingsVersion === undefined
      ? await readCurrentSettings(input.tenantId)
      : await readSettingsVersion(input.tenantId, input.settingsVersion);

  const startedAt = Date.now();
  const masked = maskPersonalData(input.text);
  trace.push({
    node: "mask",
    latencyMs: Date.now() - startedAt,
    tokensIn: 0,
    tokensOut: 0,
    costRub: 0,
    detail: `Замаскировано полей: ${masked.maskedFieldsCount}`,
  });

  const retrieveStartedAt = Date.now();
  const found = await search(masked.maskedText, input.tenantId);
  const sources: SandboxSourceWithText[] = found.map((result) => ({
    kind: result.kind,
    id: result.articleId,
    title: result.title,
    location: result.location,
    text: result.text,
  }));
  trace.push({
    node: "retrieve",
    latencyMs: Date.now() - retrieveStartedAt,
    tokensIn: 0,
    tokensOut: 0,
    costRub: 0,
    detail: `Источников: ${sources.length}`,
  });

  const client = resolveClient(settings);
  const respondStartedAt = Date.now();
  const result = await client.complete({
    sessionId: `sandbox_${sessionId}`,
    messages: [
      { role: "system", content: settings.systemPrompt },
      { role: "user", content: masked.maskedText },
      {
        role: "assistant",
        content: `Подтверждённые источники:\n${buildSandboxSourceContext(sources)}`,
      },
    ],
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  });
  trace.push({
    node: "respond",
    latencyMs: Date.now() - respondStartedAt,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costRub: result.costRub,
    detail: `Модель: ${result.model}`,
  });

  const validation = validateAnswer(
    { text: result.text, amounts: result.amounts, citations: result.citations },
    sources.map((source) => ({
      kind: "kb_article" as const,
      id: source.id,
      title: source.title,
      location: source.location,
      text: source.text,
    })),
  );

  const outcome: SandboxResult["outcome"] =
    sources.length === 0 ? "escalate" : validation.valid ? "respond" : "escalate";
  const grade: SandboxResult["grade"] =
    sources.length === 0
      ? "no_confirmed_source"
      : validation.valid
        ? "ok"
        : "invalid";

  const answer = sources.length === 0 ? "" : result.text;
  // В историю и в ответ идут безопасные метаданные источников: полный
  // текст источника в истории тестовых сессий не нужен.
  const safeSources = sources.map((source) => ({
    kind: source.kind,
    id: source.id,
    title: source.title,
    location: source.location,
  }));
  await recordTestSession({
    tenantId: input.tenantId,
    sessionId,
    settings,
    settingsVersion: settings.version,
    requestTextMasked: masked.maskedText,
    result: {
      outcome,
      answer,
      grade,
      sources: safeSources,
      violations: validation.violations.map((violation) => violation.code),
    },
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costRub: result.costRub,
    actor: input.actor,
  });

  return {
    sessionId,
    settingsVersion: settings.version,
    outcome,
    grade,
    answer,
    sources: safeSources,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costRub: result.costRub,
    trace,
  };
}

/** Снимок конфигурации для истории: без секретов. */
function settingsSnapshot(settings: AgentSettings): Record<string, unknown> {
  return {
    provider: settings.provider,
    model: settings.model,
    endpoint: settings.endpoint,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    system_prompt: settings.systemPrompt,
  };
}

type SessionRecord = {
  tenantId: string;
  sessionId: string;
  settings: AgentSettings;
  settingsVersion: number;
  requestTextMasked: string;
  result: Record<string, unknown>;
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  actor: string;
};

/** Запись тестовой сессии в историю: единственное место, куда пишет песочница. */
async function recordTestSession(record: SessionRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_test_sessions (
        id, tenant_id, settings_version, settings_snapshot, request_text_masked,
        result, tokens_in, tokens_out, cost_rub, actor
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10)`,
    [
      record.sessionId,
      record.tenantId,
      record.settingsVersion,
      JSON.stringify(settingsSnapshot(record.settings)),
      record.requestTextMasked,
      JSON.stringify(record.result),
      record.tokensIn,
      record.tokensOut,
      record.costRub,
      record.actor,
    ],
  );
}

export type TestSessionSummary = {
  sessionId: string;
  settingsVersion: number;
  settingsSnapshot: Record<string, unknown>;
  requestTextMasked: string;
  result: {
    outcome: string;
    answer: string;
    grade: string;
    sources: SandboxSource[];
  };
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  actor: string;
  /** Время сессии: миллисекунды epoch. */
  createdAt: number;
};

type TestSessionRow = {
  id: string;
  settings_version: number;
  settings_snapshot: Record<string, unknown>;
  request_text_masked: string;
  result: TestSessionSummary["result"] & { violations?: string[] };
  tokens_in: number;
  tokens_out: number;
  cost_rub: string | number;
  actor: string;
  created_at: Date;
};

/**
 * История тестовых сессий арендатора: от свежих к старым.
 *
 * В выборке нет секретов и сырых персональных данных: запрос хранится
 * маскированным, конфигурация — без секретных полей.
 */
export async function listTestSessions(
  tenantId: string,
  limit: number = 50,
): Promise<TestSessionSummary[]> {
  const pool = getPool();
  const result = await pool.query<TestSessionRow>(
    `SELECT id, settings_version, settings_snapshot, request_text_masked, result,
            tokens_in, tokens_out, cost_rub, actor, created_at
     FROM agent_test_sessions WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [tenantId, Math.max(1, Math.min(limit, 200))],
  );
  return result.rows.map((row) => ({
    sessionId: row.id,
    settingsVersion: row.settings_version,
    settingsSnapshot: row.settings_snapshot,
    requestTextMasked: row.request_text_masked,
    result: {
      outcome: row.result.outcome,
      answer: row.result.answer,
      grade: row.result.grade,
      sources: row.result.sources ?? [],
    },
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costRub: Number(row.cost_rub),
    actor: row.actor,
    createdAt: row.created_at.getTime(),
  }));
}
