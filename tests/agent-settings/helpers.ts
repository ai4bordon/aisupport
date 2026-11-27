import { ensureSchema, testPool } from "../db/helpers";

/**
 * Тестовый помощник среза 08: база `support_agent_08` и свой арендатор.
 *
 * У каждого тестового файла свой арендатор: файлы идут последовательно, но
 * общая база не затирается чужими фикстурами.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5433/support_agent_08";

/**
 * Готовит арендатора среза: применяет миграции и очищает таблицы среза.
 *
 * Таблицы `agent_settings`, `agent_dialog_settings`, `agent_test_sessions`
 * принадлежат срезу, поэтому очистка идёт по ним, а не по общему списку
 * ядра.
 */
export async function ensureSliceDatabase(slug: string): Promise<string> {
  await ensureSchema();
  const pool = testPool();

  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [slug],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId) {
    // Порядок удаления — по внешним ключам: сначала материалы и трасса,
    // потом диалоги, и только потом арендатор.
    await pool.query("DELETE FROM kb_chunks WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM kb_articles WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM kb_documents WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM agent_steps WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM escalations WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM promises WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM messages WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM conversations WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM policy_rules WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM audit_log WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM intent_taxonomy WHERE tenant_id = $1", [existingId]);
    await pool.query("DELETE FROM agent_test_sessions WHERE tenant_id = $1", [
      existingId,
    ]);
    await pool.query("DELETE FROM agent_dialog_settings WHERE tenant_id = $1", [
      existingId,
    ]);
    await pool.query("DELETE FROM agent_settings WHERE tenant_id = $1", [
      existingId,
    ]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [existingId]);
  }

  const created = await pool.query<{ id: string }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
    [slug, `Арендатор среза 08: ${slug}`],
  );
  return created.rows[0]?.id ?? "";
}

/**
 * Создаёт диалог: привязка версии конфигурации ссылается на `conversations`.
 */
export async function createConversation(
  tenantId: string,
  conversationId: string,
): Promise<string> {
  await testPool().query(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'web', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, tenantId],
  );
  return conversationId;
}

/**
 * Счётчики рабочего окружения: строки, которых песочница не должна трогать.
 */
export async function workingCounters(
  tenantId: string,
): Promise<Record<string, number>> {
  const pool = testPool();
  const counters: Record<string, number> = {};
  for (const table of [
    "messages",
    "conversations",
    "escalations",
    "promises",
    "agent_steps",
    "usage_counters",
  ]) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    counters[table] = Number(result.rows[0]?.count ?? "0");
  }
  return counters;
}
