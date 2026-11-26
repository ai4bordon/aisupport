// Потоковый разбор YML-фида.
//
// Файл построчный: элементы фида в разметке Mindbox занимают одну строку.
// Разбор идёт без загрузки файла в память — построчно, с накоплением текущей
// позиции. Категории в фиде идут раньше позиций, поэтому дерево категорий
// закрывается до первой позиции и полный путь вычисляется один раз при разборе.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export type ParsedCategory = {
  id: string;
  parentId: string | null;
  name: string;
  /** Полный путь от корня через разделитель; вычисляется при разборе дерева. */
  path: string;
};

export type ParsedOffer = {
  id: string;
  groupId: string | null;
  name: string;
  vendor: string | null;
  vendorUrl: string | null;
  url: string | null;
  price: number;
  oldPrice: number | null;
  currencyId: string;
  categoryId: string | null;
  available: boolean;
  delivery: boolean | null;
  pickup: boolean | null;
  description: string | null;
  /** Имя параметра → значение или список значений, как есть из фида. */
  params: Record<string, string | string[]>;
};

export type ParsedRecord =
  | { kind: "meta"; feedDate: string | null; shopName: string | null }
  | { kind: "category"; category: ParsedCategory }
  | { kind: "offer"; offer: ParsedOffer };

/** Разделитель полного пути категории. */
export const CATEGORY_PATH_SEPARATOR = " / ";

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    attributes[name] = decodeXml(value);
  }
  return attributes;
}

function parseBoolean(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Полный путь категории: путь родителя плюс имя, при цикле — только имя. */
export function buildCategoryPath(
  categoryId: string,
  categories: Map<string, { parentId: string | null; name: string }>,
): string {
  const segments: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null = categoryId;
  while (currentId !== null) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const node = categories.get(currentId);
    if (!node) break;
    segments.unshift(node.name);
    currentId = node.parentId;
  }
  return segments.join(CATEGORY_PATH_SEPARATOR);
}

type OfferDraft = {
  id: string;
  groupId: string | null;
  available: boolean;
  fields: Map<string, string>;
  params: Map<string, string[]>;
};

/**
 * Разбирает поток с YML-фидом и отдаёт записи по одной: сначала метаданные,
 * затем дерево категорий, затем позиции — одна за другую, без накопления
 * всего каталога в памяти.
 */
export async function* parseFeed(stream: Readable): AsyncGenerator<ParsedRecord> {
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  const categories = new Map<string, { parentId: string | null; name: string }>();
  let feedDate: string | null = null;
  let shopName: string | null = null;

  let inShop = false;
  let inCategories = false;
  let inOffers = false;
  let draft: OfferDraft | null = null;

  const takeOffer = (): ParsedOffer | null => {
    if (!draft) return null;
    const params: Record<string, string | string[]> = {};
    for (const [name, values] of draft.params) {
      params[name] = values.length === 1 ? (values[0] ?? "") : values;
    }
    const offer: ParsedOffer = {
      id: draft.id,
      groupId: draft.groupId,
      name: draft.fields.get("name") ?? "",
      vendor: draft.fields.get("vendor") ?? null,
      vendorUrl: draft.fields.get("vendorUrl") ?? null,
      url: draft.fields.get("url") ?? null,
      price: parseNumber(draft.fields.get("price") ?? null) ?? 0,
      oldPrice: parseNumber(draft.fields.get("oldprice") ?? null),
      currencyId: draft.fields.get("currencyId") ?? "RUR",
      categoryId: draft.fields.get("categoryId") ?? null,
      available: draft.available,
      delivery: parseBoolean(draft.fields.get("delivery") ?? null),
      pickup: parseBoolean(draft.fields.get("pickup") ?? null),
      description: draft.fields.get("description") ?? null,
      params,
    };
    draft = null;
    return offer;
  };

  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line.startsWith("<yml_catalog")) {
      feedDate = parseAttributes(line).date ?? null;
      yield { kind: "meta", feedDate, shopName };
      continue;
    }
    if (line === "<shop>" || line.startsWith("<shop ")) {
      inShop = true;
      continue;
    }
    if (line === "</shop>") {
      inShop = false;
      continue;
    }
    if (line === "<categories>") {
      inCategories = true;
      continue;
    }
    if (line === "</categories>") {
      inCategories = false;
      for (const [id, node] of categories) {
        yield {
          kind: "category",
          category: {
            id,
            parentId: node.parentId,
            name: node.name,
            path: buildCategoryPath(id, categories),
          },
        };
      }
      continue;
    }
    if (line === "<offers>") {
      inOffers = true;
      continue;
    }
    if (line === "</offers>") {
      inOffers = false;
      const last = takeOffer();
      if (last) yield { kind: "offer", offer: last };
      continue;
    }

    if (inCategories && line.startsWith("<category ")) {
      const attributes = parseAttributes(line);
      const id = attributes.id;
      if (!id) continue;
      const name = decodeXml(line.slice(line.indexOf(">") + 1, line.lastIndexOf("</category>")));
      categories.set(id, { parentId: attributes.parentId ?? null, name });
      continue;
    }

    if (inOffers && line.startsWith("<offer ")) {
      const pending = takeOffer();
      if (pending) yield { kind: "offer", offer: pending };
      const attributes = parseAttributes(line);
      draft = {
        id: attributes.id ?? "",
        groupId: attributes.group_id ?? null,
        available: parseBoolean(attributes.available ?? null) ?? false,
        fields: new Map(),
        params: new Map(),
      };
      continue;
    }

    if (inOffers && line === "</offer>") {
      const offer = takeOffer();
      if (offer) yield { kind: "offer", offer };
      continue;
    }

    if (!draft) {
      if (inShop) {
        const shopNameMatch = /^<name>([\s\S]*)<\/name>$/.exec(line);
        if (shopNameMatch && shopName === null) shopName = decodeXml(shopNameMatch[1] ?? "");
      }
      continue;
    }

    if (line.startsWith("<param ")) {
      const attributes = parseAttributes(line);
      const name = attributes.name;
      if (!name) continue;
      const value = decodeXml(line.slice(line.indexOf(">") + 1, line.lastIndexOf("</param>")));
      const existing = draft.params.get(name);
      if (existing) existing.push(value);
      else draft.params.set(name, [value]);
      continue;
    }

    const fieldMatch = /^<([A-Za-z_][\w]*)\s*>([\s\S]*)<\/\1>$/.exec(line);
    const tag = fieldMatch?.[1];
    const rawValue = fieldMatch?.[2];
    if (tag !== undefined && rawValue !== undefined) {
      const value = decodeXml(rawValue);
      if (tag === "group_id" && draft.groupId === null) draft.groupId = value === "" ? null : value;
      if (!draft.fields.has(tag)) draft.fields.set(tag, value);
    }
  }

  const trailing = takeOffer();
  if (trailing) yield { kind: "offer", offer: trailing };
}

/**
 * Дата фида из первой строки файла — дешёвый способ узнать её без полного разбора.
 */
export async function readFeedDate(path: string): Promise<string | null> {
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (line.includes("<yml_catalog")) {
      return parseAttributes(line.trim()).date ?? null;
    }
  }
  return null;
}

/**
 * Дата фида в ISO UTC. В фиде дата записана без часового пояса («2026-11-25 14:12»),
 * и по договорённости она трактуется как UTC: так провенанс одинаков в любом
 * часовом поясе машины, где запущен импорт.
 */
export function feedDateToIsoUtc(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(trimmed)
    ? trimmed.replace(" ", "T")
    : `${trimmed.replace(" ", "T")}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
