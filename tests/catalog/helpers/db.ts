// Общая оснастка юнит-тестов каталога.
//
// Тесты работают против локальной базы среза (PostgreSQL 16 в Docker).
// Строка подключения приходит переменной окружения DATABASE_URL. Если её нет,
// берутся стандартные переменные libpq (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)
// с локальными значениями по умолчанию из db/README.md.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function databaseConfig(): pg.ClientConfig {
  const url = process.env.DATABASE_URL;
  if (url) return { connectionString: url };
  return {
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? "postgres",
    password: process.env.PGPASSWORD ?? "postgres",
    database: process.env.PGDATABASE ?? "support_agent_12",
  };
}

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(databaseConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function splitMigration(content: string): { up: string; down: string | null } {
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
  const strip = (sql: string) => sql.replace(/^\s*--\s*(up|down)\s+migration\s*/im, "").trim();
  return { up: strip(up), down: down === null ? null : strip(down) };
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${table}`],
  );
  return result.rows[0]?.exists === true;
}

/**
 * Применяет миграции среза каталога, если их ещё нет в базе.
 * Миграции ядра (`110_tenants.sql`) принадлежат другому срезу: пока её нет
 * в репозитории, таблица `tenants` создаётся заглушкой по docs/data-model.md §3.1,
 * чтобы тесты среза не зависели от графика соседнего среза.
 */
export async function ensureSchema(): Promise<void> {
  await withClient(async (client) => {
    // Тестовые файлы идут параллельно, а схему поднимает один процесс:
    // блокировка сериализует применение миграций.
    await client.query("SELECT pg_advisory_lock(hashtext('catalog-slice-schema'))");
    try {
      await ensureSchemaUnlocked(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('catalog-slice-schema'))");
    }
  });
}

async function ensureSchemaUnlocked(client: pg.Client): Promise<void> {
  await client.query(`
      CREATE TABLE IF NOT EXISTS pgmigrations (
        id SERIAL PRIMARY KEY,
        name varchar(255) NOT NULL,
        run_on timestamp NOT NULL
      )
    `);

  const applied = new Set(
    (await client.query("SELECT name FROM pgmigrations")).rows.map((row: { name: string }) => row.name),
  );
  const migrationsDir = join(repoRoot, "db", "migrations");
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const pending = files.filter((name) => !applied.has(name));

  // Таблица `tenants` создаётся миграцией ядра `110_tenants.sql`. Пока она
  // не применена, каталогу нужен внешний ключ на неё — создаём совместимую
  // таблицу-заглушку. Миграция 110 объявлена через CREATE TABLE IF NOT EXISTS,
  // поэтому после её применения заглушка не мешает.
  const coreWillCreateTenants = pending.some((name) => name.startsWith("110_"));
  if (!coreWillCreateTenants && !(await tableExists(client, "tenants"))) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS tenants (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          slug text NOT NULL UNIQUE,
          name text NOT NULL,
          shadow_mode boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
  }

  for (const name of pending) {
    const { up } = splitMigration(await readFile(join(migrationsDir, name), "utf8"));
    await client.query("BEGIN");
    try {
      await client.query(up);
      await client.query("INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())", [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`миграция ${name} не применилась: ${(error as Error).message}`);
    }
  }
}

export async function createTenant(slug: string): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
       RETURNING id`,
      [slug, slug],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("tenant не создан");
    return id;
  });
}

export async function cleanupTenant(slug: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM price_rules WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)`,
      [slug],
    );
    await client.query(`DELETE FROM products WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)`, [
      slug,
    ]);
    await client.query(
      `DELETE FROM catalog_categories WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)`,
      [slug],
    );
    await client.query(
      `DELETE FROM catalog_snapshots WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)`,
      [slug],
    );
    await client.query(`DELETE FROM tenants WHERE slug = $1`, [slug]);
  });
}

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
