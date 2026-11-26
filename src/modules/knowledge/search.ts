import { getPool } from "@/db/pool";
import { toVectorLiteral } from "@/db/vector";

/**
 * Поиск по одобренной базе знаний.
 *
 * Инвариант (docs/api-contract.md §6): в выдачу попадают только
 * `kb_articles.status='published'` и `kb_documents.status='published'`.
 * `pending`, `draft`, `rejected` не возвращаются никогда.
 */

export type SearchResult = {
  articleId: string;
  chunkId: string;
  title: string;
  text: string;
  location: string | null;
  score: number;
};

/** Провайдер эмбеддингов — граница, на которой подменяется внешний API. */
export type EmbeddingProvider = {
  embed: (text: string) => Promise<number[]>;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/**
 * Провайдер эмбеддингов по умолчанию.
 *
 * Без ключа владельца живой вызов недоступен, поэтому используется
 * детерминированная заглушка: она даёт одинаковый вектор для одинакового
 * текста. Живой вызов проверяется exec, когда владелец выдаст ключ.
 */
export const deterministicEmbeddingProvider: EmbeddingProvider = {
  embed: async (text: string) => {
    const vector = new Array<number>(1536).fill(0);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % 1536] = 1;
    return vector;
  },
};

let embeddingProvider: EmbeddingProvider = deterministicEmbeddingProvider;

/** Подмена провайдера эмбеддингов — только для тестов и песочницы. */
export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  embeddingProvider = provider;
}

/** Первая строка чанка вида `Источник: <url>` — ссылка на источник. */
function locationFromText(text: string, pageNo: number | null): string | null {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = /^Источник:\s*(.+)$/u.exec(firstLine.trim());
  if (match?.[1]) return match[1].trim();
  if (pageNo !== null) return `с. ${pageNo}`;
  return null;
}

/** Текст чанка без служебной шапки источника. */
function bodyFromText(text: string): string {
  const lines = text.split("\n");
  if (/^Источник:\s*.+$/u.test(lines[0]?.trim() ?? "")) {
    return lines.slice(1).join("\n").trim();
  }
  return text.trim();
}

type ChunkRow = {
  chunk_id: string;
  article_id: string | null;
  document_id: string | null;
  title: string;
  text: string;
  page_no: number | null;
  score: number;
};

/**
 * Поиск по одобренным материалам.
 *
 * Сначала векторный поиск, затем текстовый запасной вариант через
 * `tsvector`: если векторное сходство ничего не дало, полнотекстовое
 * совпадение всё ещё может найти подтверждённый источник.
 */
export async function search(
  query: string,
  tenantId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<SearchResult[]> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  const pool = getPool();

  const embedding = await embeddingProvider.embed(query);

  const vectorResult = await pool.query<ChunkRow>(
    `
    SELECT
      c.id AS chunk_id,
      c.article_id,
      c.document_id,
      COALESCE(a.title, d.filename) AS title,
      c.text,
      c.page_no,
      1 - (c.embedding <=> $2::vector) AS score
    FROM kb_chunks c
    LEFT JOIN kb_articles a ON a.id = c.article_id
    LEFT JOIN kb_documents d ON d.id = c.document_id
    WHERE c.tenant_id = $1
      AND (
        (c.article_id IS NOT NULL AND a.status = 'published')
        OR (c.document_id IS NOT NULL AND d.status = 'published')
      )
    ORDER BY c.embedding <=> $2::vector
    LIMIT $3
    `,
    [tenantId, toVectorLiteral(embedding), boundedLimit],
  );

  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const row of vectorResult.rows) {
    if (row.score <= 0) continue;
    seen.add(row.chunk_id);
    results.push({
      articleId: row.article_id ?? row.document_id ?? "",
      chunkId: row.chunk_id,
      title: row.title,
      text: bodyFromText(row.text),
      location: locationFromText(row.text, row.page_no),
      score: Number(row.score),
    });
  }

  if (results.length < boundedLimit) {
    const textResult = await pool.query<ChunkRow>(
      `
      SELECT
        c.id AS chunk_id,
        c.article_id,
        c.document_id,
        COALESCE(a.title, d.filename) AS title,
        c.text,
        c.page_no,
        ts_rank(c.search_vector, plainto_tsquery('russian', $2)) AS score
      FROM kb_chunks c
      LEFT JOIN kb_articles a ON a.id = c.article_id
      LEFT JOIN kb_documents d ON d.id = c.document_id
      WHERE c.tenant_id = $1
        AND c.search_vector @@ plainto_tsquery('russian', $2)
        AND (
          (c.article_id IS NOT NULL AND a.status = 'published')
          OR (c.document_id IS NOT NULL AND d.status = 'published')
        )
      ORDER BY score DESC
      LIMIT $3
      `,
      [tenantId, query, boundedLimit],
    );

    for (const row of textResult.rows) {
      if (seen.has(row.chunk_id)) continue;
      seen.add(row.chunk_id);
      results.push({
        articleId: row.article_id ?? row.document_id ?? "",
        chunkId: row.chunk_id,
        title: row.title,
        text: bodyFromText(row.text),
        location: locationFromText(row.text, row.page_no),
        score: Number(row.score),
      });
    }
  }

  return results.slice(0, boundedLimit);
}
