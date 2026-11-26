import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { getPool } from "@/db/pool";

/**
 * Тестовый помощник: общая база для тестов среза.
 *
 * Миграции применяются тем же SQL-форматом, что и scripts/migrate.mjs
 * (`-- Up Migration` / `-- Down Migration`), в той же таблице pgmigrations,
 * поэтому предварительный `npm run db:migrate:up` и применение из теста
 * не конфликтуют.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5433/support_agent_01";

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const ADVISORY_LOCK_KEY = 728_115_001;

type MigrationFile = { name: string; up: string };

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
  const strip = (sql: string) => sql.replace(/^\s*--\s*(up|down)\s+migration\s*/im, "");
  return { up: strip(up).trim(), down: down === null ? null : strip(down).trim() };
}

async function readMigrationFiles(): Promise<MigrationFile[]> {
  const names = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const files: MigrationFile[] = [];
  for (const name of names) {
    const content = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    const { up } = splitSql(content);
    files.push({ name, up });
  }
  return files;
}

/**
 * Применяет миграции среза в отдельной схеме.
 *
 * Схема изолирует проверку миграций от остальных тестов среза: таблицы
 * среза создаются в ней, а типы (`vector`) и функции (`pgcrypto`) берутся
 * из public. Благодаря этому проверка миграций падает, если файлы миграций
 * отсутствуют или неполны, а не опирается на состояние общей базы.
 */
export async function applyMigrationsToSchema(client: PoolClient, schema: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.pgmigrations (
      id SERIAL PRIMARY KEY,
      name varchar(255) NOT NULL,
      run_on timestamp NOT NULL
    )
  `);
  for (const file of await readMigrationFiles()) {
    await client.query("BEGIN");
    try {
      await client.query(file.up);
      await client.query(
        `INSERT INTO ${schema}.pgmigrations (name, run_on) VALUES ($1, now())`,
        [file.name],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

let schemaPromise: Promise<void> | null = null;

/** Применяет миграции среза в public один раз на процесс. */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const pool = getPool();
      const client = await pool.connect();
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
          const applied = new Set(
            (await client.query("SELECT name FROM pgmigrations")).rows.map(
              (row) => row.name as string,
            ),
          );
          for (const file of await readMigrationFiles()) {
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
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
        }
      } finally {
        client.release();
      }
    })().catch((error: unknown) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export function testPool(): Pool {
  return getPool();
}

/** Полная очистка данных среза между тестами; схема сохраняется. */
export async function truncateSliceTables(): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  await pool.query(`
    TRUNCATE TABLE
      agent_steps,
      escalations,
      promises,
      messages,
      conversations,
      kb_chunks,
      kb_articles,
      kb_documents,
      policy_rules,
      audit_log,
      intent_taxonomy,
      tenants
    RESTART IDENTITY CASCADE
  `);
}
