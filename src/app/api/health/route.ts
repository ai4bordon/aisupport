import { getPool } from "@/db/pool";

/**
 * GET /health — проверка готовности процесса (docs/api-contract.md §3).
 *
 * Ответ 200: `{ "status": "ok", "database": "ok" }`.
 * Если база недоступна — 503 с `error.code = "upstream_unavailable"`.
 */
export async function GET(): Promise<Response> {
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    return Response.json({ status: "ok", database: "ok" });
  } catch {
    return Response.json(
      {
        error: {
          code: "upstream_unavailable",
          message: "База данных недоступна",
          details: {},
        },
      },
      { status: 503 },
    );
  }
}
