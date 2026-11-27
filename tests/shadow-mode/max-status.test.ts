import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as getMaxStatusRoute } from "@/app/api/max/status/route";
import { closePool } from "@/db/pool";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Статус канала MAX показывает режим тени из `tenants.shadow_mode` — того же
 * источника, что и веб-чат, и воркер. Если бы статус брал значение из
 * `channel_state`, демо показывало бы одно значение, а каналы работали бы по
 * другому.
 */

const TENANT_SLUG = "test-shadow-max-status";

let tenantId = "";

describe("статус канала MAX и режим тени", () => {
  beforeAll(async () => {
    await ensureSchema();
    tenantId = await resetTenant(TENANT_SLUG);
    process.env.TENANT_SLUG = TENANT_SLUG;
  });

  afterAll(async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);
    await closePool();
  });

  it("отражает включённый режим тени из tenants", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);

    const response = await getMaxStatusRoute();
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.shadowMode).toBe(true);
  });

  it("отражает выключенный режим тени из tenants", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);

    const response = await getMaxStatusRoute();
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.shadowMode).toBe(false);
  });
});
