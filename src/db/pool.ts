import { Pool } from "pg";
import { registerTypes } from "pgvector/pg";

let pool: Pool | null = null;

/**
 * Пул соединений с PostgreSQL + pgvector.
 *
 * Строка подключения приходит только из переменной окружения DATABASE_URL.
 * Типы pgvector регистрируются при подключении, чтобы значения `vector`
 * приходили массивами чисел, а не строками.
 */
export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    onConnect: (client) => {
      // Регистрация типов асинхронная и не должна ронять пул: значения,
      // которые мы читаем сами, разбираем в src/db/vector.ts.
      void registerTypes(client).catch(() => undefined);
    },
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
