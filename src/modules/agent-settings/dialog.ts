import { getPool } from "@/db/pool";
import { readSettingsVersion, type AgentSettings } from "./store";

/**
 * Конфигурация агента для диалога.
 *
 * Версия настройки привязывается к диалогу один раз: уже открытый диалог
 * продолжает работать на той версии, с которой начался, а следующий новый
 * диалог получает текущую. Менеджер меняет настройку — и изменение
 * действует на следующий новый диалог, а не на текущий.
 *
 * Модуль владеет этой логикой, а не `src/core/run.ts`: ядро — общая
 * поверхность, и её правку делает exec при интеграции срезов.
 */

/** Стандартные настройки: используются, если конфигурацию прочитать не удалось. */
export function fallbackSettings(): AgentSettings {
  return {
    id: "",
    tenantId: "",
    version: 1,
    provider: "opencode-go",
    model: process.env.LLM_MODEL ?? "deepseek-v4.1-flash",
    endpoint:
      process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/inference/go/v1",
    systemPrompt: "",
    temperature: 0.2,
    maxTokens: 1024,
    createdBy: "system",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Конфигурация по версии диалога.
 *
 * Диалог идентифицируется по `conversation_id`: арендатор берётся из строки
 * диалога, а не из тела запроса (docs/api-contract.md §1).
 *
 * Первый вызов привязывает текущую версию к диалогу, последующие
 * возвращают привязанную: диалог, начатый до изменения настроек, остаётся на
 * прежней версии.
 *
 * Если конфигурацию прочитать не удалось (миграция ещё не применена, база
 * недоступна), возвращаются стандартные настройки: сбой чтения настроек не
 * должен превращать каждый диалог в эскалацию.
 */
export async function resolveDialogSettings(
  conversationId: string,
): Promise<AgentSettings> {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM conversations WHERE id = $1 FOR UPDATE`,
        [conversationId],
      );
      const tenantId = conversation.rows[0]?.tenant_id;
      if (tenantId === undefined) {
        await client.query("ROLLBACK");
        return fallbackSettings();
      }

      const bound = await client.query<{ version: number }>(
        `SELECT version FROM agent_dialog_settings WHERE conversation_id = $1`,
        [conversationId],
      );
      let version = bound.rows[0]?.version;
      if (version === undefined) {
        const current = await client.query<{ version: number }>(
          `SELECT version FROM agent_settings WHERE tenant_id = $1
           ORDER BY version DESC LIMIT 1`,
          [tenantId],
        );
        version = current.rows[0]?.version;
        if (version === undefined) {
          await client.query("ROLLBACK");
          return fallbackSettings();
        }
        await client.query(
          `INSERT INTO agent_dialog_settings (conversation_id, tenant_id, version)
           VALUES ($1, $2, $3)
           ON CONFLICT (conversation_id) DO NOTHING`,
          [conversationId, tenantId, version],
        );
        const inserted = await client.query<{ version: number }>(
          `SELECT version FROM agent_dialog_settings WHERE conversation_id = $1`,
          [conversationId],
        );
        version = inserted.rows[0]?.version ?? version;
      }
      await client.query("COMMIT");

      return await readSettingsVersion(tenantId, version);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch {
    return fallbackSettings();
  }
}
