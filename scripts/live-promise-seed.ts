/**
 * Живой прогон среза 07: подготовка подтверждённого источника.
 *
 * Вектор чанка строится тем же детерминированным провайдером, которым
 * индексируется база на стенде: свой вектор дал бы поиск без совпадений.
 *
 * Запуск: npx tsx scripts/live-promise-seed.ts
 */
import { createHash } from "node:crypto";
import { getPool, closePool } from "../src/db/pool";

const TENANT_SLUG = process.env["TENANT_SLUG"] ?? "demo-tenant";
const TITLE = "Лицензирование";
const BODY =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

const EMBEDDING_DIMENSIONS = 1536;
const STOPWORDS = new Set([
  "в", "и", "на", "с", "по", "из", "как", "для", "не", "что", "это",
  "мне", "мы", "вы", "их", "его", "или", "быть", "есть", "который",
]);

function stem(word: string): string {
  return word.slice(0, 6);
}

function hashStem(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function embed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    const index = hashStem(stem(raw)) % EMBEDDING_DIMENSIONS;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  return vector;
}

async function main(): Promise<void> {
  const pool = getPool();
  const tenant = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [TENANT_SLUG],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error(`арендатор ${TENANT_SLUG} не найден`);

  const article = await pool.query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, $2, $3, 'published', now(), now())
     RETURNING id`,
    [tenantId, TITLE, BODY],
  );
  const articleId = article.rows[0]?.id ?? "";

  const vector = embed(BODY);
  await pool.query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [tenantId, articleId, BODY, `[${vector.join(",")}]`],
  );

  console.log(`статья ${articleId} опубликована для ${TENANT_SLUG}`);
  console.log(`checksum ${createHash("sha256").update(vector.join(",")).digest("hex").slice(0, 16)}`);
  await closePool();
}

await main();
