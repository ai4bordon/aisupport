import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { applyMigrationsToSchema, testPool } from "./helpers";

const SCHEMA = "migrations_check";

/**
 * Проверка миграций среза 100–170: расширения, таблицы, индексы и
 * ограничения из docs/data-model.md §3.
 *
 * Миграции применяются в отдельной схеме, поэтому проверка падает, если
 * файлы миграций отсутствуют или неполны, а не опирается на состояние
 * общей базы, подготовленное другим тестом.
 */
describe("миграции среза", () => {
  beforeAll(async () => {
    const client = await testPool().connect();
    try {
      await applyMigrationsToSchema(client, SCHEMA);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await testPool().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      client.release();
    }
    await closePool();
  });

  it("расширение vector доступно", async () => {
    const result = await testPool().query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("расширение pgcrypto доступно", async () => {
    const result = await testPool().query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("созданы все таблицы среза", async () => {
    const expected = [
      "tenants",
      "conversations",
      "messages",
      "kb_documents",
      "kb_articles",
      "kb_chunks",
      "agent_steps",
      "escalations",
      "promises",
      "policy_rules",
      "audit_log",
      "intent_taxonomy",
    ];
    const result = await testPool().query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [SCHEMA],
    );
    const actual = new Set(result.rows.map((row) => row.table_name));
    for (const table of expected) {
      expect(actual.has(table), `нет таблицы ${table}`).toBe(true);
    }
  });

  it("существует уникальный индекс (tenant_id, client_message_id)", async () => {
    const result = await testPool().query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'messages'",
      [SCHEMA],
    );
    const unique = result.rows.find(
      (row) =>
        row.indexdef.includes("UNIQUE") && row.indexdef.includes("tenant_id, client_message_id"),
    );
    expect(unique).toBeDefined();
  });

  it("существует HNSW-индекс kb_chunks_embedding_idx", async () => {
    const result = await testPool().query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'kb_chunks'",
      [SCHEMA],
    );
    const hnsw = result.rows.find((row) => row.indexname === "kb_chunks_embedding_idx");
    expect(hnsw).toBeDefined();
    expect(hnsw?.indexdef).toContain("hnsw");
    expect(hnsw?.indexdef).toContain("vector_cosine_ops");
  });

  it("ограничение num_nonnulls(document_id, article_id) = 1 действует", async () => {
    const result = await testPool().query<{ conname: string; pg_get_constraintdef: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS pg_get_constraintdef
       FROM pg_constraint
       WHERE conrelid = $1::regclass AND contype = 'c'`,
      [`${SCHEMA}.kb_chunks`],
    );
    const xor = result.rows.find((row) => row.pg_get_constraintdef.includes("num_nonnulls"));
    expect(xor).toBeDefined();

    const tenant = await testPool().query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.tenants LIMIT 1`,
    );
    const tenantId = tenant.rows[0]?.id;
    expect(tenantId).toBeDefined();

    const insertNeither = await testPool()
      .query(
        `INSERT INTO ${SCHEMA}.kb_chunks (tenant_id, document_id, article_id, chunk_no, text, search_vector, embedding)
         VALUES ($1, NULL, NULL, 0, 'x', to_tsvector('simple','x'), $2::vector)`,
        [tenantId, `[${new Array(1536).fill(0).join(",")}]`],
      )
      .then(() => null)
      .catch((error: unknown) => error as Error);
    expect(insertNeither).toBeInstanceOf(Error);
  });

  it("все миграции среза применены и записаны в pgmigrations", async () => {
    const result = await testPool().query<{ name: string }>(
      `SELECT name FROM ${SCHEMA}.pgmigrations ORDER BY name`,
    );
    // Проверяются миграции своего диапазона 100–170. После слияния волны
    // в общей базе применены и миграции соседних срезов, поэтому сравнение
    // полного списка было бы неверным.
    const sliceMigrations = result.rows
      .map((row) => row.name)
      .filter((name) => /^1[0-7]0_/.test(name));
    expect(sliceMigrations).toEqual([
      "100_extensions.sql",
      "110_tenants.sql",
      "120_conversations.sql",
      "130_knowledge_core.sql",
      "140_escalations_promises.sql",
      "150_policy_rules.sql",
      "160_audit.sql",
      "170_intent_taxonomy.sql",
    ]);
  });

  it("создан демо-тенант и девять категорий намерений", async () => {
    const tenants = await testPool().query<{ slug: string }>(
      `SELECT slug FROM ${SCHEMA}.tenants`,
    );
    expect(tenants.rows.map((row) => row.slug)).toContain("demo-tenant");

    const intents = await testPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA}.intent_taxonomy`,
    );
    expect(Number(intents.rows[0]?.count ?? "0")).toBe(9);
  });
});
