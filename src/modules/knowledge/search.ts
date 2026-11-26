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
  /** Идентификатор источника: статьи или документа. */
  articleId: string;
  /** Тип источника: статья БЗ или документ БЗ. */
  kind: "kb_article" | "kb_document";
  chunkId: string;
  title: string;
  text: string;
  location: string | null;
  score: number;
};

/**
 * Провайдер эмбеддингов — граница, на которой подменяется внешний API.
 */
export type EmbeddingProvider = {
  embed: (text: string) => Promise<number[]>;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Порог смысловой близости.
 *
 * Ниже порога вектор считается несовпадением: иначе поиск возвращал бы
 * любой материал и подтверждённым источником считался бы нерелевантный
 * фрагмент. 0.25 отделяет совпадение по теме от совпадения по формальному
 * признаку.
 */
export const MIN_VECTOR_SIMILARITY = 0.25;

/** Слова без смысловой нагрузки: в эмбеддинг не попадают. */
const STOPWORDS = new Set([
  "в",
  "и",
  "на",
  "с",
  "по",
  "из",
  "как",
  "для",
  "не",
  "что",
  "это",
  "мне",
  "мы",
  "вы",
  "их",
  "его",
  "для",
  "или",
  "быть",
  "есть",
  "который",
]);

/**
 * Огрубление слова до основы.
 *
 * Полная морфология не нужна: достаточно, чтобы «лицензию» и «лицензия»
 * давали одну координату, а «электронную» и «электронная» — другую.
 */
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

/**
 * Провайдер эмбеддингов по умолчанию.
 *
 * Без ключа владельца живой вызов недоступен, поэтому используется
 * детерминированная заглушка: одинаковый текст даёт одинаковый вектор,
 * а тексты по одной теме пересекаются по координатам. Живой вызов
 * проверяется exec, когда владелец выдаст ключ.
 */
export const deterministicEmbeddingProvider: EmbeddingProvider = {
  embed: async (text: string) => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 3) continue;
      if (STOPWORDS.has(raw)) continue;
      const index = hashStem(stem(raw)) % EMBEDDING_DIMENSIONS;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    return vector;
  },
};

let embeddingProvider: EmbeddingProvider = deterministicEmbeddingProvider;

/** Подмена провайдера эмбеддингов — только для тестов и песочницы. */
export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  embeddingProvider = provider;
}

/** Текст чанка без служебной шапки источника. */
function bodyFromText(text: string): string {
  const lines = text.split("\n");
  if (/^Источник:\s*.+$/u.test(lines[0]?.trim() ?? "")) {
    return lines.slice(1).join("\n").trim();
  }
  return text.trim();
}

/**
 * Полнотекстовый запрос из значимых слов вопроса.
 *
 * Слова соединяются через «|» (ИЛИ), а не «&»: вопрос клиента обычно
 * содержит несколько слов, из которых с источником совпадает только
 * часть — «Какая скидка на лицензию?» должен находить статью о лицензии.
 * При этом пустые и служебные слова отбрасываются, а «&» не мешает
 * отсекать нерелевантные материалы.
 */
function buildTextQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  if (terms.length === 0) return null;
  return terms.map((term) => `${term}:*`).join(" | ");
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
 * Ссылка на источник.
 *
 * Порядок: служебная шапка чанка (`Источник: <url>`), затем страница
 * документа, затем раздел статьи. Если ничего нет — ссылка отсутствует:
 * выдумывать её нельзя.
 */
function locationFromText(
  text: string,
  pageNo: number | null,
  articleTitle: string | null,
): string | null {
  const firstLine = (text.split("\n", 1)[0] ?? "").trim();
  const match = /^Источник:\s*(.+)$/u.exec(firstLine);
  if (match?.[1]) return match[1].trim();
  if (pageNo !== null) return `с. ${pageNo}`;
  if (articleTitle !== null) return `ст. «${articleTitle}»`;
  return null;
}

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
      AND 1 - (c.embedding <=> $2::vector) >= $4
    ORDER BY c.embedding <=> $2::vector
    LIMIT $3
    `,
    [tenantId, toVectorLiteral(embedding), boundedLimit, MIN_VECTOR_SIMILARITY],
  );

  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const row of vectorResult.rows) {
    if (row.score <= 0) continue;
    seen.add(row.chunk_id);
    results.push({
      articleId: row.article_id ?? row.document_id ?? "",
      kind: row.article_id ? "kb_article" : "kb_document",
      chunkId: row.chunk_id,
      title: row.title,
      text: bodyFromText(row.text),
      location: locationFromText(row.text, row.page_no, row.article_id ? row.title : null),
      score: Number(row.score),
    });
  }

  const textQuery = buildTextQuery(query);
  if (textQuery !== null && results.length < boundedLimit) {
    const textResult = await pool.query<ChunkRow>(
      `
      SELECT
        c.id AS chunk_id,
        c.article_id,
        c.document_id,
        COALESCE(a.title, d.filename) AS title,
        c.text,
        c.page_no,
        ts_rank(c.search_vector, to_tsquery('russian', $2)) AS score
      FROM kb_chunks c
      LEFT JOIN kb_articles a ON a.id = c.article_id
      LEFT JOIN kb_documents d ON d.id = c.document_id
      WHERE c.tenant_id = $1
        AND c.search_vector @@ to_tsquery('russian', $2)
        AND (
          (c.article_id IS NOT NULL AND a.status = 'published')
          OR (c.document_id IS NOT NULL AND d.status = 'published')
        )
      ORDER BY score DESC
      LIMIT $3
      `,
      [tenantId, textQuery, boundedLimit],
    );

    for (const row of textResult.rows) {
      if (seen.has(row.chunk_id)) continue;
      seen.add(row.chunk_id);
      results.push({
        articleId: row.article_id ?? row.document_id ?? "",
        kind: row.article_id ? "kb_article" : "kb_document",
        chunkId: row.chunk_id,
        title: row.title,
        text: bodyFromText(row.text),
        location: locationFromText(row.text, row.page_no, row.article_id ? row.title : null),
        score: Number(row.score),
      });
    }
  }

  return results.slice(0, boundedLimit);
}
