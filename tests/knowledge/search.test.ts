import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { search } from "@/modules/knowledge";
import { ensureSchema, testPool, truncateSliceTables } from "../db/helpers";

/**
 * Проверка допуска к поиску: в выдачу попадают только одобренные материалы.
 *
 * Фикстура: опубликованная статья, черновик статьи и документ `pending`.
 * Эмбеддинги детерминированные — внешний API векторов в тестах не вызывается.
 */
const EMBEDDING_DIMENSIONS = 1536;

function deterministicEmbedding(seed: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[seed % EMBEDDING_DIMENSIONS] = 1;
  return vector;
}

async function seedFixtures(): Promise<{ tenantId: string; publishedArticleId: string }> {
  const tenant = await testPool().query<{ id: string }>(
    "INSERT INTO tenants (slug, name) VALUES ('demo-tenant', 'Демо-тенант') RETURNING id",
  );
  const tenantId = tenant.rows[0]?.id ?? "";

  const published = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Лицензирование', 'Электронная лицензия предоставляется в течение 120 минут после оплаты.', 'published', now(), now())
     RETURNING id`,
    [tenantId],
  );
  const publishedArticleId = published.rows[0]?.id ?? "";

  await testPool().query(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from)
     VALUES ($1, 'Постоплата', 'Отсрочка платежа предоставляется по письменному согласованию.', 'draft', now())`,
    [tenantId],
  );

  const document = await testPool().query<{ id: string }>(
    `INSERT INTO kb_documents (tenant_id, filename, mime_type, size_bytes, storage_path, status)
     VALUES ($1, 'pending.pdf', 'application/pdf', 100, '/tmp/pending.pdf', 'pending')
     RETURNING id`,
    [tenantId],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector)`,
    [tenantId, publishedArticleId, "Электронная лицензия предоставляется в течение 120 минут после оплаты.", `[${deterministicEmbedding(1).join(",")}]`],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding)
     VALUES ($1, (SELECT id FROM kb_articles WHERE title = 'Постоплата' AND tenant_id = $1), 0, $2, to_tsvector('russian', $2), $3::vector)`,
    [tenantId, "Отсрочка платежа предоставляется по письменному согласованию.", `[${deterministicEmbedding(2).join(",")}]`],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, document_id, chunk_no, text, search_vector, embedding)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector)`,
    [tenantId, document.rows[0]?.id ?? "", "Материал загруженного документа ждёт одобрения менеджера.", `[${deterministicEmbedding(3).join(",")}]`],
  );

  return { tenantId, publishedArticleId };
}

describe("поиск по базе знаний", () => {
  let tenantId = "";
  let publishedArticleId = "";

  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    await truncateSliceTables();
    const fixtures = await seedFixtures();
    tenantId = fixtures.tenantId;
    publishedArticleId = fixtures.publishedArticleId;
  });

  afterAll(async () => {
    await closePool();
  });

  it("возвращает только опубликованные материалы", async () => {
    const results = await search("лицензия", tenantId);

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.articleId === publishedArticleId || result.title === "Лицензирование").toBe(true);
    }
  });

  it("в выдаче нет содержимого черновика и неодобренного документа", async () => {
    const results = await search("Отсрочка платежа предоставляется по письменному согласованию.", tenantId);
    const texts = results.map((result) => result.text);

    expect(texts.join(" ")).not.toContain("Отсрочка платежа");
    expect(texts.join(" ")).not.toContain("ждёт одобрения");
  });

  it("поиск по тексту черновика возвращает пустой результат", async () => {
    const results = await search("Отсрочка платежа", tenantId);

    expect(results).toEqual([]);
  });

  it("пустой результат возвращает [], а не выдуманный ответ", async () => {
    const results = await search("квантовая телепортация астероидов", tenantId);

    expect(results).toEqual([]);
  });

  it("limit ограничивает число результатов", async () => {
    const results = await search("лицензия", tenantId, 1);

    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("возвращает ссылку на источник", async () => {
    const results = await search("Электронная лицензия предоставляется", tenantId);

    expect(results[0]?.articleId).toBe(publishedArticleId);
    expect(results[0]?.title).toBe("Лицензирование");
    expect(results[0]?.chunkId).toBeTruthy();
  });
});
