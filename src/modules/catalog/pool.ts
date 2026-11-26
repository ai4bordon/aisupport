// Доступ к базе для каталога.
//
// Ядро ещё не слито (`src/db/pool.ts` — файл среза «ядро»), поэтому у среза
// каталога свой ленивый пул. Он читает DATABASE_URL из окружения и не держит
// соединений, пока пул не понадобился. После слияния волны exec может
// заменить этот модуль на общий `getPool()` — сигнатуры совпадают.
import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool === null) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL не задан: строка подключения передаётся переменной окружения");
    }
    pool = new Pool({ connectionString, max: 4 });
  }
  return pool;
}

export async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool === null) return;
  const current = pool;
  pool = null;
  await current.end();
}
