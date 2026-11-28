/**
 * Repair: переиндексация опубликованных статей без чанков.
 *
 * КОГДА ЗАПУСКАТЬ: только после разрешения владельца на запись в боевую БД.
 * Скрипт меняет данные стенда и без разрешения не запускается.
 *
 * ЧТО ДЕЛАЕТ:
 * 1. Находит опубликованные статьи арендатора, у которых нет ни одного
 *    чанка в `kb_chunks` — они остались вне индекса и не находятся поиском.
 * 2. Для каждой такой статьи строит чанк тем же кодом, что и импорт:
 *    `chunkSource` из `src/import/knowledge/chunk.ts` даёт текст чанка с
 *    шапкой, вектор считает текущий провайдер эмбеддингов.
 * 3. Пишет чанк в `kb_chunks` с `search_vector = to_tsvector('russian', text)`
 *    и `embedding_model` текущего провайдера.
 *
 * ПРОВЕРКА ДО ЗАПИСИ (--dry-run, по умолчанию): печатает, что будет
 * сделано, и ничего не пишет.
 *
 * ЗАПУСК:
 *   cd /opt/aisupport/app
 *   set -a && . /opt/aisupport/.env && set +a
 *   ./node_modules/.bin/tsx repair-unindexed-articles.ts            # dry-run
 *   ./node_modules/.bin/tsx repair-unindexed-articles.ts --apply    # запись
 *
 * Ключ запуска: --apply. Без него скрипт ничего не меняет.
 */

import { getPool } from "@/db/pool";
import { currentEmbeddingProvider } from "@/modules/knowledge";
import { chunkSource } from "@/import/knowledge";
import { toVectorLiteral } from "@/db/vector";

const TENANT_SLUG = "demo-tenant";

/** Статусы материала, который ищется поиском. */
const PUBLISHED = "published";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const pool = getPool();
  const provider = currentEmbeddingProvider();

  const tenant = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [TENANT_SLUG],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) {
    throw new Error(`Арендатор ${TENANT_SLUG} не найден`);
  }

  // Статьи без чанков: опубликованные, но вне индекса.
  const articles = await pool.query<{
    id: string;
    title: string;
    body_md: string;
    source_url: string | null;
    section_path: string | null;
    chunks: number;
  }>(
    `SELECT a.id, a.title, a.body_md, s.source_url, s.section_path,
            (SELECT count(*)::int FROM kb_chunks c WHERE c.article_id = a.id) AS chunks
       FROM kb_articles a
       LEFT JOIN kb_sources s ON s.id = a.id
      WHERE a.tenant_id = $1
        AND a.status = $2
        AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.article_id = a.id)
      ORDER BY a.title`,
    [tenantId, PUBLISHED],
  );

  console.log(`модель эмбеддингов: ${provider.model}`);
  console.log(`режим: ${apply ? "ЗАПИСЬ" : "dry-run (ничего не меняется)"}`);
  console.log(`статей без чанков: ${articles.rows.length}\n`);

  let written = 0;
  let skipped = 0;

  for (const article of articles.rows) {
    const chunks = chunkSource({
      url: article.source_url ?? `repair://${article.id}`,
      title: article.title,
      sectionPath: article.section_path ?? "",
      text: article.body_md,
      crawledAt: new Date().toISOString(),
    });

    // Оглавление раздела: шапка есть, содержательного текста нет.
    const withBody = chunks.filter((chunk) => {
      const body = chunk.text.split("\n").slice(1).join("\n").trim();
      return body.length >= 40;
    });
    if (withBody.length === 0) {
      console.log(`  пропуск (нет содержательного текста): ${article.title}`);
      skipped += 1;
      continue;
    }

    if (!apply) {
      console.log(`  будет записано: ${article.title} (${article.body_md.length} знаков)`);
      continue;
    }

    for (const [index, chunk] of withBody.entries()) {
      const vector = await provider.embed(chunk.text);
      await pool.query(
        `INSERT INTO kb_chunks (
           tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model
         ) VALUES ($1, $2, $3, $4, to_tsvector('russian', $4), $5::vector, $6)`,
        [
          tenantId,
          article.id,
          index,
          chunk.text,
          toVectorLiteral(vector),
          provider.model,
        ],
      );
    }
    written += 1;
    console.log(`  записано: ${article.title}`);
  }

  console.log(
    `\nготово: записано ${written}, пропущено ${skipped}${
      apply ? "" : " (dry-run: база не менялась)"
    }`,
  );
  await pool.end();
}

void main();
