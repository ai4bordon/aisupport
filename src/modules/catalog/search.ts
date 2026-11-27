// Структурный поиск по каталогу.
//
// Поиск каталога — структурный: точное совпадение `offer_id`, полнотекстовый
// поиск по названию через `tsvector`, фильтры по вендору, категории
// (с подкатегориями), наличию и параметрам. Вектора у каталога нет:
// векторный индекс применяется только к базе знаний и статьям.
//
// Наличие в карточке означает состояние датированного снимка фида, а не
// текущий склад или срок поставки: карточка показывает дату снимка и хеш.
import { getPool } from "./pool";

export type CatalogFilters = {
  vendor?: string;
  categoryId?: string;
  availableOnly?: boolean;
  limit?: number;
  /**
   * Фильтр по параметрам: имя параметра → значение. Имя сравнивается точно,
   * значение — как в фиде, без нормализации.
   */
  params?: Record<string, string>;
  /**
   * Маркеры категорий фида: позиция подходит, если её категория содержит
   * хотя бы один маркер.
   *
   * Нужен для подбора по задаче, а не по названию: на запрос «защитить почту»
   * поиск по словам названия находил «Защитный чехол с ремнем на плечо» и
   * «Проектирование дорожных знаков». Категория отсекает такие позиции.
   */
  categoryPathMarkers?: string[];
  /**
   * Арендатор определяется сервером, не приходит из тела запроса клиента.
   * Если не задан, берётся `demo-tenant`.
   */
  tenantId?: string;
};

export type CatalogHit = {
  offerId: string;
  name: string;
  vendor: string | null;
  categoryPath: string | null;
  price: number;
  available: boolean;
  /** Цена больше нуля — цена подтверждена заказчиком. */
  priceConfirmed: boolean;
  /** Дата фида: снимок, из которого взята позиция. */
  feedDate: string;
  /** SHA-256 снимка фида. */
  snapshotHash: string;
};

export type CatalogItem = CatalogHit & {
  groupId: string | null;
  vendorUrl: string | null;
  productUrl: string | null;
  oldPrice: number | null;
  currencyId: string;
  categoryId: string | null;
  delivery: boolean | null;
  pickup: boolean | null;
  description: string | null;
  params: Record<string, string | string[]>;
};

export type CatalogSearchOptions = {
  tenantId?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 50;

type HitRow = {
  offer_id: string;
  name: string;
  vendor: string | null;
  category_path: string | null;
  price: string;
  available: boolean;
  feed_date: Date | null;
  snapshot_hash: string;
};

type ItemRow = HitRow & {
  group_id: string | null;
  vendor_url: string | null;
  product_url: string | null;
  old_price: string | null;
  currency_id: string;
  category_id: string | null;
  delivery: boolean | null;
  pickup: boolean | null;
  description: string | null;
  params: Record<string, string | string[]>;
};

const HIT_COLUMNS = `
  p.offer_id, p.name, p.vendor, p.price, p.available,
  c.path AS category_path,
  s.feed_date, s.snapshot_hash
`;

function toHit(row: HitRow): CatalogHit {
  return {
    offerId: row.offer_id,
    name: row.name,
    vendor: row.vendor,
    categoryPath: row.category_path,
    price: Number(row.price),
    available: row.available,
    priceConfirmed: Number(row.price) > 0,
    feedDate: row.feed_date ? row.feed_date.toISOString() : "",
    snapshotHash: row.snapshot_hash,
  };
}

async function resolveTenantId(tenantId: string | undefined): Promise<string | null> {
  const pool = getPool();
  if (tenantId) {
    const result = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
    return result.rows[0]?.id ?? null;
  }
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = $1`,
    ["demo-tenant"],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Собирает условие запроса по фильтрам. Параметры возвращаются отдельным
 * списком, чтобы параметр с несколькими значениями находился и по точному
 * значению, и по вхождению в список.
 */
function buildFilters(
  filters: CatalogFilters,
  startIndex: number,
): { clauses: string[]; values: unknown[]; nextIndex: number } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let index = startIndex;

  if (filters.vendor !== undefined) {
    index += 1;
    clauses.push(`p.vendor = $${index}`);
    values.push(filters.vendor);
  }

  if (filters.categoryId !== undefined) {
    index += 1;
    // Подкатегории входят по префиксу полного пути: путь потомка начинается
    // с пути родителя через разделитель.
    clauses.push(`p.category_id IN (
      SELECT cc.category_id FROM catalog_categories cc
      WHERE cc.tenant_id = p.tenant_id
        AND (cc.category_id = $${index} OR cc.path LIKE (
          SELECT parent.path || ' / ' || '%'
          FROM catalog_categories parent
          WHERE parent.tenant_id = p.tenant_id AND parent.category_id = $${index}
        ))
    )`);
    values.push(filters.categoryId);
  }

  if (filters.availableOnly === true) {
    clauses.push(`p.available = true`);
  }

  const markers = filters.categoryPathMarkers ?? [];
  if (markers.length > 0) {
    index += 1;
    // Категория позиции должна содержать хотя бы один маркер домена. Фильтр
    // по `c.path` покрывает и родительскую категорию: подкатегория наследует
    // домен родителя.
    const markerClauses = markers
      .map((_marker, markerIndex) => {
        const markerValueIndex = index + markerIndex;
        return `lower(c.path) LIKE '%' || lower($${markerValueIndex}) || '%'`;
      })
      .join(" OR ");
    clauses.push(`(${markerClauses})`);
    values.push(...markers);
    index += markers.length - 1;
  }

  for (const [name, value] of Object.entries(filters.params ?? {})) {
    index += 1;
    // Имя параметра сравнивается точно; значение может лежать в списке.
    clauses.push(
      `(p.params->>$${index} = $${index + 1} OR p.params->$${index} @> to_jsonb($${index + 1}::text))`,
    );
    values.push(name, value);
    index += 1;
  }

  return { clauses, values, nextIndex: index };
}

export async function search(query: string, filters: CatalogFilters = {}): Promise<CatalogHit[]> {
  const tenantId = await resolveTenantId(filters.tenantId);
  if (!tenantId) return [];

  const limit = filters.limit ?? DEFAULT_LIMIT;
  const { clauses, values, nextIndex } = buildFilters(filters, 1);
  const trimmed = query.trim();

  const parameters: unknown[] = [tenantId, ...values];
  const conditions: string[] = [`p.tenant_id = $1`];

  // Слова запроса и условие совпадения по каждому из них.
  //
  // Полнотекстовое условие собирается как «слово ИЛИ префикс»: `plainto_tsquery`
  // требует все слова сразу, и запрос «MDaemon Standard» не нашёл бы «MDaemon»,
  // в названии которого слова «Standard» нет. Порядок результатов задаёт
  // число совпавших слов — иначе поиск по «MDaemon» возвращал «SmartDraw»,
  // где слова запроса встречались в описании, а не в названии.
  const words =
    trimmed === ""
      ? []
      : trimmed
          .split(/[^\p{L}\p{N}]+/u)
          .filter((word) => word.length > 1)
          .slice(0, 8);

  const wordIndexes: number[] = [];
  if (trimmed !== "") {
    const queryIndex = nextIndex + 1;
    parameters.push(trimmed);
    wordIndexes.push(queryIndex);
    for (const word of words) {
      parameters.push(word);
      wordIndexes.push(parameters.length);
    }
    const wordClauses = wordIndexes
      .slice(1)
      .map(
        (wordIndex) =>
          `to_tsvector('russian', p.name) @@ to_tsquery('russian', $${wordIndex} || ':*')`,
      );
    conditions.push(
      words.length === 0
        ? `p.offer_id = $${queryIndex}`
        : `(p.offer_id = $${queryIndex} OR ${wordClauses.join(" OR ")})`,
    );
  }

  conditions.push(...clauses);

  const limitIndex = parameters.length + 1;
  parameters.push(limit);

  // Ранжирование: число совпавших слов — по убыванию; затем первое слово
  // запроса — обычно это маркер бренда, и позиция с ним релевантнее, даже
  // если совпало столько же слов; затем позиции с подтверждённой ценой;
  // затем по идентификатору для устойчивого порядка.
  const matchCount =
    wordIndexes.length > 1
      ? wordIndexes
          .slice(1)
          .map(
            (wordIndex) =>
              `(CASE WHEN to_tsvector('russian', p.name) @@ to_tsquery('russian', $${wordIndex} || ':*') THEN 1 ELSE 0 END)`,
          )
          .join(" + ")
      : "0";
  const firstWordIndex = wordIndexes[1];
  const brandClause =
    firstWordIndex === undefined
      ? "0"
      : `(CASE WHEN lower(p.name) LIKE '%' || lower($${firstWordIndex}) || '%' THEN 0 ELSE 1 END)`;
  const orderBy =
    wordIndexes.length > 1
      ? `ORDER BY (${matchCount}) DESC, ${brandClause}, (CASE WHEN p.price > 0 THEN 0 ELSE 1 END), p.offer_id`
      : "ORDER BY (CASE WHEN p.price > 0 THEN 0 ELSE 1 END), p.offer_id";

  const sql = `
    SELECT ${HIT_COLUMNS}
    FROM products p
    JOIN catalog_snapshots s ON s.id = p.snapshot_id
    LEFT JOIN catalog_categories c
      ON c.tenant_id = p.tenant_id AND c.category_id = p.category_id
    WHERE ${conditions.join(" AND ")}
    ${orderBy}
    LIMIT $${limitIndex}
  `;

  const pool = getPool();
  const result = await pool.query<HitRow>(sql, parameters);
  return result.rows.map(toHit);
}

export async function getByOfferId(
  offerId: string,
  options: CatalogSearchOptions = {},
): Promise<CatalogItem | null> {
  const tenantId = await resolveTenantId(options.tenantId);
  if (!tenantId) return null;

  const pool = getPool();
  const result = await pool.query<ItemRow>(
    `SELECT ${HIT_COLUMNS},
            p.group_id, p.vendor_url, p.product_url, p.old_price, p.currency_id,
            p.category_id, p.delivery, p.pickup, p.description, p.params
     FROM products p
     JOIN catalog_snapshots s ON s.id = p.snapshot_id
     LEFT JOIN catalog_categories c
       ON c.tenant_id = p.tenant_id AND c.category_id = p.category_id
     WHERE p.tenant_id = $1 AND p.offer_id = $2
     LIMIT 1`,
    [tenantId, offerId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    ...toHit(row),
    groupId: row.group_id,
    vendorUrl: row.vendor_url,
    productUrl: row.product_url,
    oldPrice: row.old_price === null ? null : Number(row.old_price),
    currencyId: row.currency_id,
    categoryId: row.category_id,
    delivery: row.delivery,
    pickup: row.pickup,
    description: row.description,
    params: row.params,
  };
}
