import { getPool } from "@/db/pool";
import { DEFAULT_SYSTEM_PROMPT } from "@/core/system-prompt";

/**
 * Системный промпт агента по умолчанию.
 *
 * Промпт живёт в модуле настроек, а не в `src/core/run.ts`: конфигурация
 * агента хранится в базе, и стартовая версия 1 должна получить тот же текст,
 * что и ядро. Дублировать текст в двух местах нельзя — правки разъедутся, и
 * сохранённая конфигурация перестанет совпадать с тем, что реально отвечает
 * ядро.
 *
 * Ядро берёт промпт из сохранённой конфигурации; значение по умолчанию —
 * этот текст.
 */
export function defaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}

/**
 * Настройки агента: версионируемая конфигурация (docs/plans/08-agent-settings-sandbox.md).
 *
 * Инварианты:
 * - в конфигурации лежат только настройки с работающим потребителем;
 * - изменение создаёт новую версию, предыдущая остаётся в истории;
 * - изменение и запись аудита происходят в одной транзакции;
 * - секретные поля не принимаются и не хранятся;
 * - режим тени не хранится здесь: его единственный источник — `tenants.shadow_mode`.
 */

export type AgentSettings = {
  id: string;
  tenantId: string;
  version: number;
  provider: string;
  model: string;
  endpoint: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  createdBy: string;
  /** Время создания версии: ISO 8601 UTC. */
  createdAt: string;
};

/** Настройки, которые ядро и клиент модели действительно читают. */
export type SettingsKey =
  | "provider"
  | "model"
  | "endpoint"
  | "system_prompt"
  | "temperature"
  | "max_tokens";

/**
 * Поля, которые не хранятся в конфигурации ни при каких условиях.
 *
 * Ключ провайдера живёт только в переменной окружения: в базе, аудите и
 * трассе секретов нет.
 */
export const SECRET_FIELD_NAMES = [
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "authorization",
];

/** Ключи, которые описывают нереализованные настройки. */
export const UNSUPPORTED_SETTING_KEYS = [
  "tools",
  "skills",
  "mcp",
  "limits",
  "top_p",
  "seed",
  "promises.schedule",
];

/** Настройки, которые ядро и клиент модели читают. */
const CHANGEABLE_KEYS: SettingsKey[] = [
  "provider",
  "model",
  "endpoint",
  "system_prompt",
  "temperature",
  "max_tokens",
];

type SettingsRow = {
  id: string;
  tenant_id: string;
  version: number;
  provider: string;
  model: string;
  endpoint: string;
  system_prompt: string;
  temperature: string | number;
  max_tokens: number;
  created_by: string;
  created_at: Date;
};

function toSettings(row: SettingsRow): AgentSettings {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    provider: row.provider,
    model: row.model,
    endpoint: row.endpoint,
    systemPrompt: row.system_prompt,
    temperature: Number(row.temperature),
    maxTokens: row.max_tokens,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** Провайдер по умолчанию: OpenCode Go. */
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_ENDPOINT = "https://opencode.ai/inference/go/v1";
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Стартовая конфигурация из окружения.
 *
 * Значения по умолчанию используются только для настроек, которые менеджер
 * ещё не задал: первая версия создаётся один раз и дальше меняется только
 * через `updateSetting`.
 */
function initialSettings(): {
  provider: string;
  model: string;
  endpoint: string;
  temperature: number;
  maxTokens: number;
} {
  return {
    provider: process.env.LLM_PROVIDER ?? DEFAULT_PROVIDER,
    model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
    endpoint: process.env.OPENCODE_BASE_URL ?? DEFAULT_ENDPOINT,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/** Ошибка изменения настройки: понятная причина и код ответа. */
export class SettingsError extends Error {
  readonly code: "validation_error" | "not_implemented" | "secret_forbidden";

  constructor(
    message: string,
    code: "validation_error" | "not_implemented" | "secret_forbidden" = "validation_error",
  ) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

/**
 * Значение настройки приводится к типу колонки.
 *
 * Приведение и проверка идут здесь, а не в базе: ошибка должна быть
 * понятна менеджеру до записи, а не после отказа ограничения.
 */
function normalizeValue(key: SettingsKey, value: unknown): string | number {
  if (key === "temperature" || key === "max_tokens") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new SettingsError(`Настройка «${key}» должна быть числом`);
    }
    if (key === "temperature" && (numeric < 0 || numeric > 2)) {
      throw new SettingsError(
        "Настройка «temperature» должна быть в диапазоне от 0 до 2",
      );
    }
    if (key === "max_tokens" && (!Number.isInteger(numeric) || numeric <= 0)) {
      throw new SettingsError(
        "Настройка «max_tokens» должна быть целым числом больше нуля",
      );
    }
    return numeric;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SettingsError(`Настройка «${key}» должна быть непустой строкой`);
  }
  return value.trim();
}

/**
 * Проверка ключа настройки.
 *
 * Ключ проверяется по трём причинам: секретные поля не хранятся вовсе,
 * нереализованные настройки не принимают значений, а режим тени меняется
 * отдельным сервисом в `tenants.shadow_mode`.
 */
function assertChangeableKey(key: string): asserts key is SettingsKey {
  if (SECRET_FIELD_NAMES.includes(key.toLowerCase())) {
    throw new SettingsError(
      `Секретное поле «${key}» не хранится в конфигурации: ключ задаётся переменной окружения`,
      "secret_forbidden",
    );
  }
  if (key === "shadow_mode") {
    throw new SettingsError(
      "Ключ «shadow_mode» не принимается: режим тени меняется в tenants.shadow_mode отдельным сервисом",
    );
  }
  if (UNSUPPORTED_SETTING_KEYS.includes(key)) {
    throw new SettingsError(
      `Настройка «${key}» отключена: изменение не реализовано`,
      "not_implemented",
    );
  }
  if (!CHANGEABLE_KEYS.includes(key as SettingsKey)) {
    throw new SettingsError(`Настройка «${key}» не существует`);
  }
}

/**
 * Стартовая версия конфигурации, если её ещё нет.
 *
 * Вызывается перед любой операцией, которой нужна текущая версия: иначе
 * первое изменение менеджера падало бы с «конфигурация не найдена».
 */
async function ensureBaseline(tenantId: string): Promise<void> {
  const pool = getPool();
  const defaults = initialSettings();
  await pool.query(
    `INSERT INTO agent_settings (tenant_id, version, provider, model, endpoint, system_prompt, temperature, max_tokens, created_by)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'system')
     ON CONFLICT (tenant_id, version) DO NOTHING`,
    [
      tenantId,
      defaults.provider,
      defaults.model,
      defaults.endpoint,
      defaultSystemPrompt(),
      defaults.temperature,
      defaults.maxTokens,
    ],
  );
}

/**
 * Текущая версия конфигурации арендатора.
 *
 * Первый вызов создаёт стартовую версию 1 из значений окружения и
 * стандартного промпта ядра. Создание идемпотентно: параллельные вызовы
 * не заводят две версии 1.
 */
export async function readCurrentSettings(tenantId: string): Promise<AgentSettings> {
  await ensureBaseline(tenantId);
  const pool = getPool();
  const result = await pool.query<SettingsRow>(
    `SELECT id, tenant_id, version, provider, model, endpoint, system_prompt, temperature, max_tokens, created_by, created_at
     FROM agent_settings WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new SettingsError("Конфигурация агента не найдена");
  }
  return toSettings(row);
}

/**
 * Конфигурация конкретной версии.
 *
 * Нужна диалогу: версия привязывается к диалогу один раз, и дальше диалог
 * работает на той версии, с которой начался.
 */
export async function readSettingsVersion(
  tenantId: string,
  version: number,
): Promise<AgentSettings> {
  const pool = getPool();
  const result = await pool.query<SettingsRow>(
    `SELECT id, tenant_id, version, provider, model, endpoint, system_prompt, temperature, max_tokens, created_by, created_at
     FROM agent_settings WHERE tenant_id = $1 AND version = $2`,
    [tenantId, version],
  );
  const row = result.rows[0];
  if (!row) {
    throw new SettingsError(`Версия конфигурации ${version} не найдена`);
  }
  return toSettings(row);
}

/** Текущее значение настройки в версии: ключ настройки → значение. */
function valueFromRow(row: SettingsRow, key: SettingsKey): string | number {
  if (key === "system_prompt") return row.system_prompt;
  if (key === "temperature") return Number(row.temperature);
  if (key === "max_tokens") return row.max_tokens;
  return row[key];
}

/**
 * Изменение настройки: новая версия и запись аудита в одной транзакции.
 *
 * Прежняя версия остаётся в истории: диалоги, начатые до изменения,
 * продолжают работать на своей версии.
 */
export async function updateSetting(
  tenantId: string,
  key: string,
  value: unknown,
  actor: string,
): Promise<AgentSettings> {
  assertChangeableKey(key);
  const normalized = normalizeValue(key, value);
  await ensureBaseline(tenantId);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<SettingsRow>(
      `SELECT id, tenant_id, version, provider, model, endpoint, system_prompt, temperature, max_tokens, created_by, created_at
       FROM agent_settings WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [tenantId],
    );
    const row = current.rows[0];
    if (!row) {
      throw new SettingsError("Конфигурация агента не найдена");
    }

    const next = {
      provider: key === "provider" ? (normalized as string) : row.provider,
      model: key === "model" ? (normalized as string) : row.model,
      endpoint: key === "endpoint" ? (normalized as string) : row.endpoint,
      system_prompt:
        key === "system_prompt" ? (normalized as string) : row.system_prompt,
      temperature:
        key === "temperature" ? (normalized as number) : Number(row.temperature),
      max_tokens:
        key === "max_tokens" ? (normalized as number) : row.max_tokens,
    };

    const inserted = await client.query<SettingsRow>(
      `INSERT INTO agent_settings (tenant_id, version, provider, model, endpoint, system_prompt, temperature, max_tokens, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, tenant_id, version, provider, model, endpoint, system_prompt, temperature, max_tokens, created_by, created_at`,
      [
        tenantId,
        row.version + 1,
        next.provider,
        next.model,
        next.endpoint,
        next.system_prompt,
        next.temperature,
        next.max_tokens,
        actor,
      ],
    );

    // Аудит пишется в той же транзакции: изменение без следа опаснее
    // отсутствия изменения.
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity, before, after)
       VALUES ($1, $2, 'update', 'agent_settings', $3::jsonb, $4::jsonb)`,
      [
        tenantId,
        actor,
        JSON.stringify({ [key]: valueFromRow(row, key) }),
        JSON.stringify({ [key]: normalized }),
      ],
    );

    await client.query("COMMIT");
    const newRow = inserted.rows[0];
    if (!newRow) {
      throw new SettingsError("Версия конфигурации не создана");
    }
    return toSettings(newRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Привязка версии конфигурации к диалогу.
 *
 * Первый вызов запоминает текущую версию, последующие возвращают её же:
 * диалог, начатый до изменения настройки, продолжает работать на прежней
 * версии, а новый диалог получает текущую.
 */
export async function bindDialogVersion(
  tenantId: string,
  conversationId: string,
): Promise<number> {
  await ensureBaseline(tenantId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ version: number }>(
      `SELECT version FROM agent_settings WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [tenantId],
    );
    const version = current.rows[0]?.version;
    if (version === undefined) {
      throw new SettingsError("Конфигурация агента не найдена");
    }
    await client.query(
      `INSERT INTO agent_dialog_settings (conversation_id, tenant_id, version)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id) DO NOTHING`,
      [conversationId, tenantId, version],
    );
    const bound = await client.query<{ version: number }>(
      `SELECT version FROM agent_dialog_settings WHERE conversation_id = $1`,
      [conversationId],
    );
    await client.query("COMMIT");
    return bound.rows[0]?.version ?? version;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** История версий конфигурации арендатора: от стартовой к текущей. */
export async function listVersions(tenantId: string): Promise<AgentSettings[]> {
  const pool = getPool();
  const result = await pool.query<SettingsRow>(
    `SELECT id, tenant_id, version, provider, model, endpoint, system_prompt, temperature, max_tokens, created_by, created_at
     FROM agent_settings WHERE tenant_id = $1 ORDER BY version ASC`,
    [tenantId],
  );
  return result.rows.map(toSettings);
}

/**
 * Переключатель режима тени.
 *
 * Единственный источник истины — `tenants.shadow_mode` (ADR-0008, тикет 06):
 * дублировать значение в конфигурации агента нельзя, иначе веб-чат и MAX
 * показали бы разное состояние. Изменение попадает в аудит.
 */
export async function setShadowMode(
  tenantId: string,
  enabled: boolean,
  actor: string,
): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ shadow_mode: boolean }>(
      `SELECT shadow_mode FROM tenants WHERE id = $1 FOR UPDATE`,
      [tenantId],
    );
    const previous = current.rows[0]?.shadow_mode ?? false;
    await client.query(`UPDATE tenants SET shadow_mode = $2 WHERE id = $1`, [
      tenantId,
      enabled,
    ]);
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity, before, after)
       VALUES ($1, $2, 'update', 'tenants', $3::jsonb, $4::jsonb)`,
      [
        tenantId,
        actor,
        JSON.stringify({ shadow_mode: previous }),
        JSON.stringify({ shadow_mode: enabled }),
      ],
    );
    await client.query("COMMIT");
    return enabled;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Текущее состояние режима тени арендатора. */
export async function readShadowMode(tenantId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ shadow_mode: boolean }>(
    `SELECT shadow_mode FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return result.rows[0]?.shadow_mode ?? false;
}
