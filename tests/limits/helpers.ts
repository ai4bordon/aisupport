import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

/**
 * Тестовый помощник среза 11: общая база `support_agent_11`.
 *
 * Миграции применяются тем же SQL-форматом, что и `scripts/migrate.mjs`
 * (`-- Up Migration` / `-- Down Migration`), в той же таблице `pgmigrations`,
 * поэтому предварительный `npm run db:migrate:up` и применение из теста
 * не конфликтуют.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5433/support_agent_11";

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const ADVISORY_LOCK_KEY = 728_111_002;

/**
 * Таблица `tenants` принадлежит ядру (миграция 110). Пока ядро не слито в
 * `main`, её нет в рабочем дереве среза, а счётчики без арендатора работать
 * не могут: `usage_counters.tenant_id` — внешний ключ на `tenants(id)`.
 * DDL повторяет миграцию 110 один в один, поэтому после слияния ядра
 * `CREATE TABLE IF NOT EXISTS` ничего не меняет.
 */
const TENANTS_DDL = `
  CREATE TABLE IF NOT EXISTS tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    shadow_mode boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

function splitSql(content: string): { up: string; down: string | null } {
  const upMarker = /^\s*--\s*up\s+migration/im;
  const downMarker = /^\s*--\s*down\s+migration/im;
  const upStart = content.search(upMarker);
  const downStart = content.search(downMarker);
  const up =
    upStart >= 0
      ? content.slice(upStart, downStart >= 0 && downStart < upStart ? undefined : downStart)
      : content;
  const down =
    downStart >= 0
      ? content.slice(downStart, upStart >= 0 && upStart < downStart ? undefined : upStart)
      : null;
  const strip = (sql: string) => sql.replace(/^\s*--\s*(up|down)\s*migration\s*/im, "");
  return { up: strip(up).trim(), down: down === null ? null : strip(down).trim() };
}

async function readMigrationFiles(): Promise<Array<{ name: string; up: string }>> {
  const names = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const files: Array<{ name: string; up: string }> = [];
  for (const name of names) {
    const content = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    files.push({ name, up: splitSql(content).up });
  }
  return files;
}

/**
 * Готовит базу среза: применяет миграции среза, создаёт таблицу арендатора
 * (если ядро ещё не слито) и заводит арендатора теста.
 *
 * У каждого тестового файла свой арендатор, поэтому файлы, идущие параллельно,
 * не выжигают квоту друг друга: счётчики разнесены по `tenant_id`.
 */
export async function ensureDatabase(tenantSlug: string): Promise<void> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.TENANT_SLUG = tenantSlug;

  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS pgmigrations (
          id SERIAL PRIMARY KEY,
          name varchar(255) NOT NULL,
          run_on timestamp NOT NULL
        )
      `);
      await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      const files = await readMigrationFiles();
      const applied = new Set(
        (await client.query("SELECT name FROM pgmigrations")).rows.map(
          (row) => row.name as string,
        ),
      );
      // Пока ядро не слито в `main`, миграции 100–999 в дереве среза нет,
      // а `usage_counters` ссылается на `tenants(id)`. Таблица арендатора
      // создаётся заранее — DDL повторяет миграцию 110 без INSERT.
      const hasTenantsMigration = files.some((file) => file.name.startsWith("110_"));
      if (!hasTenantsMigration) {
        await client.query(TENANTS_DDL);
      }
      for (const file of files) {
        if (applied.has(file.name)) continue;
        await client.query("BEGIN");
        try {
          await client.query(file.up);
          await client.query(
            "INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())",
            [file.name],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }

      await client.query(
        `INSERT INTO tenants (slug, name, shadow_mode)
         VALUES ($1, $2, false)
         ON CONFLICT (slug) DO NOTHING`,
        [tenantSlug, `Демо-тенант среза 11: ${tenantSlug}`],
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Очистка счётчиков текущего арендатора между тестами.
 *
 * Чужие строки не трогаются: параллельные тестовые файлы используют разных
 * арендаторов и не мешают друг другу.
 */
export async function resetCounters(): Promise<void> {
  const slug = process.env.TENANT_SLUG;
  if (!slug) {
    throw new Error("TENANT_SLUG не задан: тест обязан вызвать ensureDatabase");
  }
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM usage_counters
        WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)`,
      [slug],
    );
  } finally {
    await client.end();
  }
}
