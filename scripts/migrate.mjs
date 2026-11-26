#!/usr/bin/env node
// Раннер миграций для SQL-файлов.
//
// node-pg-migrate грузит .sql-миграции через sqlMigration: файл делится маркерами
// `-- Up Migration` и `-- Down Migration`. Каждая часть выполняется как есть.
//
// Формат файла миграции:
//
//   -- Up Migration
//   CREATE TABLE ...;
//   -- Down Migration
//   DROP TABLE ...;
//
// Запуск: node scripts/migrate.mjs up|down|status
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

const direction = process.argv[2] ?? "up";
const migrationsDir = resolve(process.cwd(), "db/migrations");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL не задан");
  process.exit(2);
}

const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS pgmigrations (
    id SERIAL PRIMARY KEY,
    name varchar(255) NOT NULL,
    run_on timestamp NOT NULL
  )
`);

const applied = new Set(
  (await client.query("SELECT name FROM pgmigrations")).rows.map((row) => row.name),
);

function splitSql(content) {
  const upMarker = /^\s*--\s*up\s+migration/im;
  const downMarker = /^\s*--\s*down\s+migration/im;
  const upStart = content.search(upMarker);
  const downStart = content.search(downMarker);
  const up = upStart >= 0
    ? content.slice(upStart, downStart >= 0 && downStart < upStart ? undefined : downStart)
    : content;
  const down = downStart >= 0
    ? content.slice(downStart, upStart >= 0 && upStart < downStart ? undefined : upStart)
    : undefined;
  const strip = (sql) => sql.replace(/^\s*--\s*(up|down)\s+migration\s*/im, "");
  return { up: strip(up).trim(), down: down === undefined ? undefined : strip(down).trim() };
}

if (direction === "status") {
  for (const name of files) {
    console.log(`${applied.has(name) ? "применена" : "ожидает  "}  ${name}`);
  }
  await client.end();
  process.exit(0);
}

const pending = direction === "up"
  ? files.filter((name) => !applied.has(name))
  : [...files].reverse().filter((name) => applied.has(name));

if (direction === "down") {
  const target = pending[0];
  if (!target) {
    console.log("нечего откатывать");
    await client.end();
    process.exit(0);
  }
  const { down } = splitSql(await readFile(join(migrationsDir, target), "utf8"));
  if (!down) {
    console.error(`в миграции ${target} нет блока -- Down Migration`);
    await client.end();
    process.exit(1);
  }
  await client.query("BEGIN");
  try {
    await client.query(down);
    await client.query("DELETE FROM pgmigrations WHERE name = $1", [target]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`откат ${target} не удался: ${error.message}`);
    await client.end();
    process.exit(1);
  }
  console.log(`откачено: ${target}`);
  await client.end();
  process.exit(0);
}

for (const name of pending) {
  const { up } = splitSql(await readFile(join(migrationsDir, name), "utf8"));
  await client.query("BEGIN");
  try {
    await client.query(up);
    await client.query("INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())", [name]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`миграция ${name} не удалась: ${error.message}`);
    await client.end();
    process.exit(1);
  }
  console.log(`применено: ${name}`);
}

await client.end();
