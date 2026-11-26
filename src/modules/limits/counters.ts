import { createHash } from "node:crypto";
import { Pool } from "pg";

/**
 * Счётчики стенда в базе (docs/data-model.md §3.20).
 *
 * Счётчики не в памяти процесса: перезапуск сервера не обнуляет суточный
 * счётчик диалогов, а перевыпуск cookie не создаёт новую квоту.
 */

export type CounterScope =
  | "requests_minute"
  | "dialogs_daily"
  | "model_budget_hour"
  | "model_budget_day";

export type CounterValue = {
  counter: number;
  spendRub: number;
};

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) {
    return pool;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL не задан");
  }
  pool = new Pool({ connectionString, max: 5 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) {
    return;
  }
  const current = pool;
  pool = null;
  await current.end();
}

/** Слаг арендатора стенда: счётчики общие для всех cookie этого стенда. */
export const STAND_TENANT_SLUG = "demo-tenant";

let tenantIdPromise: Promise<string> | null = null;

/**
 * `tenant_id` определяется сервером из сессии и не принимается из тела
 * запроса (docs/data-model.md §5, ДОПУЩЕНИЕ A-DATA-01). Для стенда это
 * единственный демо-арендатор.
 */
export async function getTenantId(): Promise<string> {
  if (!tenantIdPromise) {
    tenantIdPromise = (async () => {
      const slug = process.env.TENANT_SLUG ?? STAND_TENANT_SLUG;
      const result = await getPool().query<{ id: string }>(
        "SELECT id FROM tenants WHERE slug = $1",
        [slug],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`Арендатор стенда не найден: ${slug}`);
      }
      return row.id;
    })().catch((error: unknown) => {
      tenantIdPromise = null;
      throw error;
    });
  }
  return tenantIdPromise;
}

/** Ключ окна запросов: минута, в которой пришёл запрос. */
export function minuteWindowStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCSeconds(0, 0);
  return start;
}

/** Ключ окна часового бюджета: час, в котором тратятся деньги. */
export function hourWindowStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

/** Ключ окна суточного бюджета и суточного счётчика диалогов. */
export function dayWindowStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/**
 * Ключ счётчика запросов — необратимый отпечаток IP.
 *
 * Счётчик считается по IP, но сам адрес в базе не хранится: в журнале и
 * в базе остаётся только отпечаток, из которого адрес не восстановить.
 */
export function ipBucketKey(ip: string): string {
  return createHash("sha256").update(ip, "utf8").digest("hex");
}

/** Ключ суточного счётчика диалогов — стенд общий для всех cookie. */
export const STAND_BUCKET_KEY = "stand";

/**
 * Атомарное увеличение счётчика: `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * Конкурентные запросы не теряют увеличения: значение, которое вернул
 * `RETURNING`, — это число запросов в окне после учёта текущего.
 */
export async function incrementCounter(
  scope: CounterScope,
  bucketKey: string,
  windowStart: Date,
): Promise<number> {
  const tenantId = await getTenantId();
  const result = await getPool().query<{ counter: string }>(
    `INSERT INTO usage_counters (tenant_id, scope, bucket_key, counter, spend_rub, window_start)
     VALUES ($1, $2, $3, 1, 0, $4)
     ON CONFLICT (tenant_id, scope, bucket_key, window_start)
     DO UPDATE SET counter = usage_counters.counter + 1, updated_at = now()
     RETURNING counter`,
    [tenantId, scope, bucketKey, windowStart],
  );
  return Number(result.rows[0]?.counter ?? 0);
}

/** Текущее значение счётчика окна; отсутствующая строка — ноль. */
export async function readCounter(
  scope: CounterScope,
  bucketKey: string,
  windowStart: Date,
): Promise<CounterValue> {
  const tenantId = await getTenantId();
  const result = await getPool().query<{ counter: string; spend_rub: string }>(
    `SELECT counter, spend_rub
       FROM usage_counters
      WHERE tenant_id = $1 AND scope = $2 AND bucket_key = $3 AND window_start = $4`,
    [tenantId, scope, bucketKey, windowStart],
  );
  const row = result.rows[0];
  return {
    counter: Number(row?.counter ?? 0),
    spendRub: Number(row?.spend_rub ?? 0),
  };
}

/**
 * Атомарное добавление расхода в окно бюджета.
 *
 * Расход прибавляется только после успешного вызова модели: стоимость
 * неуспешного вызова равна нулю, поэтому повторная обработка ответа
 * провайдера с ошибкой 429 или 402 не списывает лимит повторно.
 */
export async function addSpend(
  scope: CounterScope,
  bucketKey: string,
  windowStart: Date,
  costRub: number,
): Promise<number> {
  const tenantId = await getTenantId();
  const result = await getPool().query<{ spend_rub: string }>(
    `INSERT INTO usage_counters (tenant_id, scope, bucket_key, counter, spend_rub, window_start)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT (tenant_id, scope, bucket_key, window_start)
     DO UPDATE SET spend_rub = usage_counters.spend_rub + EXCLUDED.spend_rub, updated_at = now()
     RETURNING spend_rub`,
    [tenantId, scope, bucketKey, costRub, windowStart],
  );
  return Number(result.rows[0]?.spend_rub ?? 0);
}
