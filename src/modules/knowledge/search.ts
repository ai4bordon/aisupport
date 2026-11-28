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
 * Условие допуска к выдаче.
 *
 * Allowlist один на обе ветви выдачи — векторную и полнотекстовую. Раздельные
 * условия расходились бы при правке: в одной ветке можно было бы забыть
 * закрыть `pending` и выдать ожидающий материал. `pending`, `error`,
 * `rejected` и `draft` не проходят никогда — их нельзя раскрыть и прямыми
 * параметрами запроса: публичный `search` таких параметров не принимает.
 */
const PUBLISHED_SOURCE_PREDICATE = `
  (
    (c.article_id IS NOT NULL AND a.status = 'published')
    OR (c.document_id IS NOT NULL AND d.status = 'published')
  )
`;

/**
 * Провайдер эмбеддингов — граница, на которой подменяется внешний API.
 */
export type EmbeddingProvider = {
  embed: (text: string) => Promise<number[]>;
  /**
   * Идентификатор модели, которой построены векторы.
   *
   * Поиск сверяет его с моделью индекса: вектор запроса, построенный другой
   * моделью, не сравним с вектором чанка, и такое сравнение даёт мусор вместо
   * совпадений.
   */
  model: string;
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
  model: "deterministic-hash-v1",
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

/**
 * Провайдер эмбеддингов, которым индексирована база знаний.
 *
 * Возвращает `null`, если провайдер ещё не выбран: без ключа владельца
 * векторный поиск работает на детерминированной заглушке, и чанки, собранные
 * живой моделью, с ней не сравнимы.
 */
export function currentEmbeddingProvider(): EmbeddingProvider {
  return embeddingProvider;
}

/**
 * Выбор провайдера эмбеддингов при старте приложения.
 *
 * Раньше провайдер всегда оставался заглушкой на хешах, а чанки в базе лежали
 * с живыми векторами: векторное сравнение было бессмысленным, и поиск
 * работал только по текстовому совпадению. Теперь при наличии ключа
 * выбирается живой провайдер, и модель фиксируется в чанках при импорте.
 *
 * Идентификатор модели возвращается для трассы: по нему видно, каким
 * провайдером построен вектор запроса.
 */
export function initEmbeddingProvider(options?: {
  apiKey?: string;
  model?: string;
}): EmbeddingProvider {
  const apiKey = options?.apiKey ?? process.env["OPENCODE_API_KEY"];
  if (apiKey && apiKey.length > 0) {
    embeddingProvider = createOpenCodeEmbeddingProvider({
      apiKey,
      model: options?.model ?? process.env["EMBEDDING_MODEL"],
    });
  } else {
    embeddingProvider = deterministicEmbeddingProvider;
  }
  return embeddingProvider;
}

/**
 * Живой провайдер эмбеддингов через OpenCode Go.
 *
 * Подписка Go обслуживает эмбеддинги отдельным [OI]-совместимым путём
 * `/inference/go/openai/v1/embeddings`; заголовок сессии здесь не нужен.
 * Размерность 1536 совпадает с моделью данных, поэтому её не меняем.
 *
 * Модели, не входящие в Go, молча не подменяются: при ответе 400 бросается
 * ошибка с текстом провайдера, чтобы это было видно в эскалации.
 */
export function createOpenCodeEmbeddingProvider(
  options: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
    fetchImpl?: typeof fetch;
  } = {},
): EmbeddingProvider {
  const baseUrl =
    options.baseUrl ?? "https://opencode.ai/inference/go/openai/v1";
  const model = options.model ?? "qwen3-embedding-8b";
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    model,
    embed: async (text: string): Promise<number[]> => {
      if (!options.apiKey) {
        throw new Error("Ключ модели не задан: векторный поиск недоступен");
      }
      const response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model, input: [text], dimensions }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Провайдер эмбеддингов вернул ${response.status}: ${body.slice(0, 300)}`,
        );
      }
      const payload = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vector = payload.data?.[0]?.embedding;
      if (!vector || vector.length !== dimensions) {
        throw new Error(
          `Провайдер эмбеддингов вернул вектор размерности ${vector?.length ?? 0} вместо ${dimensions}`,
        );
      }
      return vector;
    },
  };
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
  /**
   * Число терминов вопроса, совпавших с заголовком и путём раздела.
   *
   * Заголовок и путь — это то, что клиент назвал своими словами: вопрос
   * «Как оплатить подписку?» и материал «Способы оплаты заказа» из
   * раздела «Оплата подписки» говорят об одном и том же. Считается по
   * `tsvector`, поэтому словоформы учитываются: «оплатить» и «оплаты» —
   * одно слово.
   */
  title_hits: number;
};

/**
 * Термины вопроса для полнотекстового поиска и подсчёта совпадений.
 *
 * Слова короче трёх знаков и служебные отбрасываются: они не различают
 * материалы и только размывают совпадение.
 */
function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

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
/**
 * Слияние веток выдачи.
 *
 * Векторный и текстовый поиск дают несравнимые оценки: смысловая близость
 * и ранг полнотекстовой выдачи измеряют разное, поэтому в одну шкалу их
 * смешивать нельзя. Слияние идёт по обратному рангу (reciprocal rank
 * fusion): вклад ветки тем больше, чем выше её материал в своей выдаче.
 *
 * Так материал, который точно совпал с вопросом по словам, не теряется
 * за сходными по смыслу, но не совпавшими по словам: на живом стенде
 * вопрос «Как оплатить подписку?» давал пять API-справочников в
 * векторной выдаче, а инструкция «Способы оплаты заказа» была девятой в
 * текстовой и до объединения не доходила вовсе.
 */
const RRF_K = 60;

/**
 * Слияние двух выдач по обратному рангу.
 *
 * `vectorRanks` и `textRanks` — номера материалов в своей выдаче, начиная
 * с единицы. Материал, найденный обеими ветвями, получает вклад обеих.
 */
function fuseRanks(
  vectorRanks: Map<string, number>,
  textRanks: Map<string, number>,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const [chunkId, rank] of vectorRanks) {
    fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (RRF_K + rank));
  }
  for (const [chunkId, rank] of textRanks) {
    fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (RRF_K + rank));
  }
  return fused;
}

export async function search(
  query: string,
  tenantId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<SearchResult[]> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  // Пул кандидатов шире итогового лимита: обе ветки сначала собирают
  // материалы, и только потом идёт слияние и отбор.
  //
  // Без этого материал отбрасывался до слияния: на стенде вопрос «Как
  // оплатить подписку?» давал в текстовой ветке «Способы оплаты заказа»
  // девятым, а пул был ограничен пятью — и инструкция до слияния не
  // доходила вовсе.
  const candidateLimit = Math.max(boundedLimit * 4, 20);
  const pool = getPool();

  const embedding = await embeddingProvider.embed(query);
  const model = embeddingProvider.model;

  const vectorResult = await pool.query<ChunkRow>(
    `
    SELECT
      c.id AS chunk_id,
      c.article_id,
      c.document_id,
      COALESCE(a.title, d.filename) AS title,
      c.text,
      c.page_no,
      1 - (c.embedding <=> $2::vector) AS score,
      -- Совпадения терминов вопроса с заголовком и путём раздела: считается
      -- по tsvector, поэтому словоформы учитываются.
      (SELECT count(*)::int
         FROM unnest($6::text[]) AS term
        WHERE to_tsvector('russian', COALESCE(a.title, d.filename) || ' ' || COALESCE(src.section_path, ''))
              @@ plainto_tsquery('russian', term)
      ) AS title_hits
    FROM kb_chunks c
    LEFT JOIN kb_articles a ON a.id = c.article_id
    LEFT JOIN kb_documents d ON d.id = c.document_id
    LEFT JOIN kb_sources src ON src.id = c.article_id
    WHERE c.tenant_id = $1
      AND c.embedding_model = $5
      AND ${PUBLISHED_SOURCE_PREDICATE}
      AND 1 - (c.embedding <=> $2::vector) >= $4
    ORDER BY c.embedding <=> $2::vector
    LIMIT $3
    `,
    [
      tenantId,
      toVectorLiteral(embedding),
      candidateLimit,
      MIN_VECTOR_SIMILARITY,
      model,
      queryTerms(query),
    ],
  );

  const seen = new Set<string>();
  const results: SearchResult[] = [];

  // Векторная выдача: смысловая близость.
  const vectorRows: ChunkRow[] = [];
  const vectorRanks = new Map<string, number>();
  for (const row of vectorResult.rows) {
    if (row.score <= 0) continue;
    vectorRows.push(row);
    vectorRanks.set(row.chunk_id, vectorRanks.size + 1);
  }

  // Текстовая выдача: совпадение по словам вопроса.
  //
  // Ветка выполняется всегда, а не только как запасная. Раньше она
  // срабатывала лишь тогда, когда вектор не заполнил лимит: на живом
  // стенде вектор давал пять сходных материалов и занимал лимит целиком,
  // поэтому текстовая ветка не выполнялась вовсе.
  const textQuery = buildTextQuery(query);
  const textRows: ChunkRow[] = [];
  const textRanks = new Map<string, number>();
  if (textQuery !== null) {
    const textResult = await pool.query<ChunkRow>(
      `
      SELECT
        c.id AS chunk_id,
        c.article_id,
        c.document_id,
        COALESCE(a.title, d.filename) AS title,
        c.text,
        c.page_no,
        ts_rank(c.search_vector, to_tsquery('russian', $2)) AS score,
        (SELECT count(*)::int
           FROM unnest($4::text[]) AS term
          WHERE to_tsvector('russian', COALESCE(a.title, d.filename) || ' ' || COALESCE(src.section_path, ''))
                @@ plainto_tsquery('russian', term)
        ) AS title_hits
      FROM kb_chunks c
      LEFT JOIN kb_articles a ON a.id = c.article_id
      LEFT JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN kb_sources src ON src.id = c.article_id
      WHERE c.tenant_id = $1
        AND c.search_vector @@ to_tsquery('russian', $2)
        AND ${PUBLISHED_SOURCE_PREDICATE}
      ORDER BY score DESC
      LIMIT $3
      `,
      [tenantId, textQuery, candidateLimit, queryTerms(query)],
    );

    for (const row of textResult.rows) {
      textRows.push(row);
      textRanks.set(row.chunk_id, textRanks.size + 1);
    }
  }

  // Слияние веток по обратному рангу.
  const fused = fuseRanks(vectorRanks, textRanks);

  // Бонус за совпадение с вопросом в заголовке материала: заголовок — это
  // то, что клиент назвал своими словами. На живом стенде вопрос «Как
  // оплатить подписку?» вёл к пяти API-справочникам, а инструкция
  // «Способы оплаты заказа» — единственный материал, чей заголовок
  // отвечает на вопрос, — стоял девятым.
  const rowsById = new Map<string, ChunkRow>();
  for (const row of [...vectorRows, ...textRows]) {
    if (!rowsById.has(row.chunk_id)) rowsById.set(row.chunk_id, row);
  }

  const ranked = [...fused.entries()]
    .map(([chunkId, base]) => {
      const row = rowsById.get(chunkId);
      const hits = row === undefined ? 0 : row.title_hits;
      return { chunkId, score: base, hits, row };
    })
    .filter((item) => item.row !== undefined)
    // Порядок: сначала материалы, чьи заголовок и путь раздела покрывают
    // больше терминов вопроса, затем — обратный ранг слияния.
    //
    // Совпадения идут первыми, потому что обратный ранг сам по себе
    // различает материалы слабо: разница между первым и девятым местом в
    // одной ветке меньше процента, и бонус за заголовок её не перевешивал.
    // Покрытие же прямо отвечает на вопрос: заголовок и путь раздела — это
    // то, что клиент назвал своими словами.
    .sort((left, right) => right.hits - left.hits || right.score - left.score)
    .slice(0, boundedLimit);

  for (const item of ranked) {
    const row = item.row as ChunkRow;
    if (seen.has(row.chunk_id)) continue;
    seen.add(row.chunk_id);
    results.push({
      articleId: row.article_id ?? row.document_id ?? "",
      kind: row.article_id ? "kb_article" : "kb_document",
      chunkId: row.chunk_id,
      title: row.title,
      text: bodyFromText(row.text),
      location: locationFromText(row.text, row.page_no, row.article_id ? row.title : null),
      // Оценка — обратный ранг слияния веток выдачи: она показывает, насколько
      // материал высок в обеих ветках. Разные ветки дают разные шкалы, и
      // сравнивать оценки разных материалов между собой бессмысленно —
      // для этого есть порядок выдачи.
      score: item.score,
    });
  }

  return results;
}
