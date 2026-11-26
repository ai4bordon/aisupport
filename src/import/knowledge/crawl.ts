/**
 * Обход сайта заказчика в ширину с кэшем на диске.
 *
 * Правила вежливости (контракт §8.1, спецификация R18):
 * - один запрос в секунду, никаких параллельных залпов;
 * - понятный User-Agent с контактом;
 * - при 429 или 5xx обход останавливается с причиной, уже собранное сохраняется;
 * - сырой HTML кладётся в кэш, повторный запуск берёт кэш и не дёргает сайт.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { extractPage, type ExtractedPage } from "./extract";

export type CrawlOptions = {
  /** Корневые адреса обхода. */
  roots: string[];
  /** Максимальная глубина: корень — глубина 0. */
  maxDepth: number;
  /** Пауза между запросами в миллисекундах. */
  delayMs: number;
  /** User-Agent с указанием контакта. */
  userAgent: string;
  /** Каталог кэша сырого HTML. */
  cacheDir: string;
  /** Таймбокс обхода в миллисекундах. */
  timeBudgetMs: number;
  /**
   * Только кэш: сайт не запрашивается, страницы вне кэша пропускаются.
   * Нужен для пересборки импорта из уже собранного материала.
   */
  cacheOnly?: boolean;
};

export type CrawledPage = ExtractedPage & {
  /** Путь к файлу кэша с сырым HTML. */
  rawHtmlPath: string;
  /** Дата обхода в ISO 8601 UTC. */
  crawledAt: string;
};

export type CrawlReport = {
  visited: number;
  cached: number;
  failed: number;
  stoppedReason: "completed" | "rate_limited" | "server_error" | "time_budget";
  pages: CrawledPage[];
  /** URL, на котором обход остановился, если остановка была вынужденной. */
  stoppedAtUrl?: string;
  /** HTTP-статус, вызвавший остановку. */
  stoppedStatus?: number;
};

type QueueItem = {
  url: string;
  depth: number;
};

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Ключ дедупликации: адрес без хвостового слеша, без якоря и без запроса.
 * Хвостовой слешш в самом URL сохраняется — у store.softline.ru путь
 * `/delivery_info/` существует именно со слешем.
 */
function canonicalKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/** Путь файла кэша для URL: sha256 от канонического URL. */
function cachePath(cacheDir: string, url: string): string {
  const hash = createHash("sha256").update(canonicalKey(url)).digest("hex");
  return join(cacheDir, `${hash}.html`);
}

/** Приводит ссылку к абсолютному URL; служебные схемы отбрасываются. */
function resolveLink(href: string, pageUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("#")) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) return null;

  let resolved: URL;
  try {
    resolved = new URL(trimmed, pageUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  resolved.hash = "";
  return resolved.toString();
}

/** Собирает ссылки страницы. */
function extractLinks(html: string, pageUrl: string): string[] {
  const links: string[] = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi;
  let match = pattern.exec(html);
  while (match !== null) {
    const href = match[2] ?? match[3] ?? match[4] ?? "";
    const resolved = resolveLink(href, pageUrl);
    if (resolved) links.push(resolved);
    match = pattern.exec(html);
  }
  return links;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  // Promise.withResolvers доступен в Node 22, но не описан в lib ES2023,
  // поэтому таймер ожидания пишется без него.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Обходит сайт в ширину и возвращает собранные страницы.
 *
 * @param options параметры обхода.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlReport> {
  const { roots, maxDepth, delayMs, userAgent, cacheDir, timeBudgetMs } = options;
  const deadline = Date.now() + timeBudgetMs;

  await mkdir(cacheDir, { recursive: true });

  const firstRoot = roots[0];
  if (!firstRoot) throw new Error("Не заданы корни обхода");
  const baseOrigin = originOf(firstRoot);

  const seen = new Set<string>();
  const queue: QueueItem[] = [];
  for (const root of roots) {
    const key = canonicalKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ url: root, depth: 0 });
  }

  const pages: CrawledPage[] = [];
  let visited = 0;
  let cached = 0;
  let failed = 0;
  let stoppedReason: CrawlReport["stoppedReason"] = "completed";
  let stoppedAtUrl: string | undefined;
  let stoppedStatus: number | undefined;
  let lastRequestAt = 0;

  while (queue.length > 0) {
    if (Date.now() >= deadline) {
      stoppedReason = "time_budget";
      break;
    }

    const item = queue.shift();
    if (!item) break;

    const filePath = cachePath(cacheDir, item.url);
    let html: string | null = null;
    let pageUrl = item.url;

    try {
      html = await readFile(filePath, "utf8");
      cached += 1;
    } catch {
      html = null;
    }

    if (html === null) {
      if (options.cacheOnly) {
        // Страницы вне кэша пропускаются: сайт не запрашивается.
        continue;
      }

      const waitFor = lastRequestAt + delayMs - Date.now();
      if (waitFor > 0) await sleep(waitFor);
      if (Date.now() >= deadline) {
        stoppedReason = "time_budget";
        break;
      }

      lastRequestAt = Date.now();
      let response: Response;
      try {
        response = await fetch(item.url, {
          headers: {
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml",
            "accept-language": "ru-RU,ru;q=0.9",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // Сеть недоступна — дальше идти бессмысленно, обход останавливается.
        failed += 1;
        stoppedReason = "server_error";
        stoppedAtUrl = item.url;
        break;
      }

      if (response.status === 429) {
        failed += 1;
        stoppedReason = "rate_limited";
        stoppedAtUrl = item.url;
        stoppedStatus = 429;
        break;
      }
      if (response.status >= 500) {
        failed += 1;
        stoppedReason = "server_error";
        stoppedAtUrl = item.url;
        stoppedStatus = response.status;
        break;
      }
      if (!response.ok) {
        // 404 и прочие 4xx: страницы нет, обход продолжается.
        failed += 1;
        continue;
      }

      html = await response.text();
      pageUrl = response.url || item.url;
      await writeFile(filePath, html, "utf8");
      visited += 1;
    }

    const extracted = extractPage(html, pageUrl);
    pages.push({
      ...extracted,
      rawHtmlPath: filePath,
      crawledAt: new Date().toISOString(),
    });

    if (item.depth >= maxDepth) continue;

    for (const link of extractLinks(html, pageUrl)) {
      if (originOf(link) !== baseOrigin) continue;
      const key = canonicalKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ url: link, depth: item.depth + 1 });
    }
  }

  return {
    visited,
    cached,
    failed,
    stoppedReason,
    pages,
    ...(stoppedAtUrl === undefined ? {} : { stoppedAtUrl }),
    ...(stoppedStatus === undefined ? {} : { stoppedStatus }),
  };
}
