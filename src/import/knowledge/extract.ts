/**
 * Извлечение заголовка, пути разделов и основного текста из серверного HTML.
 *
 * Разметка и служебные блоки (шапка, подвал, навигация, скрипты, стили)
 * отбрасываются: в базу знаний попадает только текст.
 *
 * Разбор HTML — собственным небольшим парсером: у среза нет права добавлять
 * зависимости, а страницы заказчика — серверный HTML без скриптовых страниц.
 */

export type ExtractedPage = {
  url: string;
  title: string;
  sectionPath: string;
  text: string;
};

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Теги, содержимое которых не является текстом статьи. */
const DROPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "button",
  "select",
  "option",
  "nav",
  "form",
]);

/**
 * Служебные блоки: в классе элемента встречается один из этих кусков имени.
 * Список подобран под оба сайта заказчика (docs.softline.com — Nuxt,
 * store.softline.ru — BEM), поэтому сверка идёт по подстроке, а не по токену.
 * Хлебные крошки в список не входят: они разбираются отдельно и попадают
 * в путь разделов.
 */
const DROPPED_CLASS_SUBSTRINGS = [
  "header",
  "footer",
  "sidebar",
  "navigation",
  "cookie",
  "banner",
  "widget",
  "search",
  "social",
  "share",
  "feedback",
  "service-block",
  "quick-help",
  "b-page__aside",
  "modal",
  "popup",
  "submenu",
];

type Node = {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  times: "×",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function normalize(text: string): string {
  return decodeEntities(text)
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ ]*\n[ ]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Убирает HTML-комментарии и содержимое script/style/svg до разбора. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match = pattern.exec(raw);
  while (match !== null) {
    const name = (match[1] ?? "").toLowerCase();
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    match = pattern.exec(raw);
  }
  return attrs;
}

/** Разбирает HTML в дерево узлов. */
function parseHtml(html: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: Node[] = [root];
  const tagPattern = /<(\/)?([a-zA-Z][-a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

  let lastIndex = 0;
  let match = tagPattern.exec(html);
  while (match !== null) {
    const between = html.slice(lastIndex, match.index);
    const parent = stack[stack.length - 1];
    if (parent && between.length > 0) parent.text += between;
    lastIndex = tagPattern.lastIndex;

    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const rawAttrs = match[3] ?? "";

    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]?.tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else {
      const node: Node = { tag, attrs: parseAttributes(rawAttrs), children: [], text: "" };
      const current = stack[stack.length - 1];
      if (current) current.children.push(node);
      if (!VOID_TAGS.has(tag) && !rawAttrs.trimEnd().endsWith("/")) stack.push(node);
    }
    match = tagPattern.exec(html);
  }

  const tail = html.slice(lastIndex);
  const current = stack[stack.length - 1];
  if (current && tail.length > 0) current.text += tail;
  return root;
}

function classOf(node: Node): string {
  return node.attrs["class"] ?? "";
}

/** Служебный блок: тег из списка или класс с одним из служебных кусков имени. */
function isServiceBlock(node: Node): boolean {
  if (DROPPED_TAGS.has(node.tag)) return true;
  const className = classOf(node).toLowerCase();
  if (className.length === 0) return false;
  return DROPPED_CLASS_SUBSTRINGS.some((needle) => className.includes(needle));
}

/** Собирает текст узла, пропуская служебные блоки. */
function collectText(node: Node, out: string[]): void {
  if (isServiceBlock(node)) return;
  if (node.text.trim().length > 0) out.push(decodeEntities(node.text));
  for (const child of node.children) collectText(child, out);
}

/** Текст узла с переносом строки между блочными элементами. */
function textOf(node: Node | null, skipServiceBlocks = true): string {
  if (!node) return "";
  const parts: string[] = [];
  if (skipServiceBlocks) {
    collectText(node, parts);
  } else {
    if (node.text.trim().length > 0) parts.push(decodeEntities(node.text));
    for (const child of node.children) collectText(child, parts);
  }
  return normalize(parts.join("\n"));
}

function findByTag(node: Node, tag: string): Node | null {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return null;
}

function findAllByTag(node: Node, tag: string): Node[] {
  const result: Node[] = [];
  for (const child of node.children) {
    if (child.tag === tag) result.push(child);
    result.push(...findAllByTag(child, tag));
  }
  return result;
}

/** Первый узел, у которого класс или id содержат подстроку. */
function findByMarker(node: Node, marker: string): Node | null {
  for (const child of node.children) {
    const candidates = `${classOf(child)} ${child.attrs["id"] ?? ""}`.toLowerCase();
    if (candidates.includes(marker)) return child;
    const found = findByMarker(child, marker);
    if (found) return found;
  }
  return null;
}

/**
 * Элементы-хлебные крошки: листья с классом, содержащим «breadcrumb».
 * Контейнеры (breadcrumbs, breadcrumbs__wrap) пропускаются — у них есть
 * вложенные крошки.
 */
function breadcrumbItems(container: Node): Node[] {
  const items: Node[] = [];
  for (const child of container.children) {
    const className = classOf(child).toLowerCase();
    const isBreadcrumb = className.includes("breadcrumb");
    if (!isBreadcrumb) continue;
    const nested = breadcrumbItems(child);
    if (nested.length > 0) {
      items.push(...nested);
    } else {
      items.push(child);
    }
  }
  return items;
}

/** Путь разделов из хлебных крошек: «Softline ID / Авторизация». */
function extractSectionPath(root: Node): string {
  const container = findByMarker(root, "breadcrumb");
  if (!container) return "";
  const parts = breadcrumbItems(container)
    .map((item) => textOf(item))
    .filter((text) => text.length > 0 && !text.startsWith("http"));
  return parts.join(" / ");
}

/**
 * Заголовок страницы.
 *
 * Приоритет — заголовок статьи h1. Но на корневых разделах сайта заказчика
 * h1 — баннер «Справочный центр», одинаковый для всех восьми разделов;
 * там берётся заголовок документа из <title>.
 */
function extractTitle(root: Node): string {
  const headings = findAllByTag(root, "h1");
  for (const heading of headings) {
    const className = classOf(heading).toLowerCase();
    if (className.includes("background__title") || className.includes("page__title")) continue;
    const text = textOf(heading);
    if (text.length > 0) return text;
  }

  const titleNode = findByTag(root, "title");
  if (titleNode) {
    const raw = textOf(titleNode);
    // Отсекаем хвост вида « — База Знаний Softline» или « — Softline ID».
    const cut = raw.split(/\s+[—–|]\s+/)[0] ?? raw;
    return (cut ?? raw).trim();
  }
  return "";
}

/** Основной текст страницы: содержимое статьи без служебных блоков. */
function extractText(root: Node): string {
  const article =
    findByTag(root, "article") ??
    findByMarker(root, "section-content") ??
    findByMarker(root, "b-page-content") ??
    findByTag(root, "main");

  const source = article ?? root;
  const parts: string[] = [];
  collectText(source, parts);
  return normalize(parts.join("\n"));
}

/**
 * Извлекает из HTML заголовок, путь разделов и текст.
 *
 * @param html сырой HTML страницы.
 * @param url адрес страницы-источника.
 */
export function extractPage(html: string, url: string): ExtractedPage {
  const root = parseHtml(stripNonContent(html));
  return {
    url,
    title: extractTitle(root),
    sectionPath: extractSectionPath(root),
    text: extractText(root),
  };
}
