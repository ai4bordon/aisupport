import { getPool } from "@/db/pool";

/**
 * Единая точка определения tenant_id.
 *
 * Идентификатор арендатора определяется сервером и никогда не принимается
 * из тела запроса (docs/api-contract.md §1, docs/data-model.md §5).
 * В этом срезе барьер доступа ещё нет (отдельный тикет 11), поэтому
 * используется единственный демо-тенант.
 */
export const DEFAULT_TENANT_SLUG = "demo-tenant";

export class TenantNotFoundError extends Error {
  constructor(slug: string) {
    super(`tenant not found: ${slug}`);
    this.name = "TenantNotFoundError";
  }
}

export async function getTenantId(): Promise<string> {
  const slug = process.env.TENANT_SLUG ?? DEFAULT_TENANT_SLUG;
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [slug],
  );
  const row = result.rows[0];
  if (!row) throw new TenantNotFoundError(slug);
  return row.id;
}
