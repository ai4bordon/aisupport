import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { GET } from "@/app/api/health/route";
import { ensureSchema } from "../db/helpers";

describe("GET /health", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  afterAll(async () => {
    await closePool();
  });

  it("возвращает 200 со статусом ok и проверкой базы", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; database: string };
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
  });

  it("возвращает 503 upstream_unavailable, когда база недоступна", async () => {
    const original = process.env.DATABASE_URL;
    // Пул — синглтон, поэтому его нужно закрыть, чтобы новый адрес был учтён.
    await closePool();
    process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/nonexistent";
    try {
      const response = await GET();

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("upstream_unavailable");
    } finally {
      process.env.DATABASE_URL = original;
      await closePool();
    }
  });
});
