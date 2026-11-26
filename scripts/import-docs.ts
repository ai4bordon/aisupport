#!/usr/bin/env tsx
/**
 * Импорт базы знаний с сайта заказчика.
 *
 * Запуск:
 *   npm run import:docs -- --roots id,lk,subscriptions,vendors,checkout,merchant-portal,payment,allsoft \
 *     --max-depth 3 --delay-ms 1000 --time-budget-ms 900000
 *
 * Скрипт обходит сайт, сохраняет сырой HTML в кэш, извлекает текст,
 * нарезает его на чанки, считает векторы и записывает источники.
 * Ненулевой код завершения — если при импорте были ошибки.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import { crawlSite } from "../src/import/knowledge/crawl";
import { importCrawledPages } from "../src/import/knowledge/importer";

const DOCS_BASE = "https://docs.softline.com/ru-ru";
const STORE_URL = "https://store.softline.ru/delivery_info/";

const DEFAULT_ROOTS = [
  "id",
  "lk",
  "subscriptions",
  "vendors",
  "checkout",
  "merchant-portal",
  "payment",
  "allsoft",
];

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 (+https://github.com/ai4bordon/aisupport)";

type Args = {
  roots: string[];
  maxDepth: number;
  delayMs: number;
  timeBudgetMs: number;
  cacheDir: string;
  userAgent: string;
  includeStore: boolean;
  storeUrl: string;
  tenantSlug: string;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(name);
      continue;
    }
    values.set(name, next);
    i += 1;
  }

  const roots = (values.get("roots") ?? DEFAULT_ROOTS.join(","))
    .split(",")
    .map((root) => root.trim())
    .filter((root) => root.length > 0);

  return {
    roots,
    maxDepth: Number.parseInt(values.get("max-depth") ?? "3", 10),
    delayMs: Number.parseInt(values.get("delay-ms") ?? "1000", 10),
    timeBudgetMs: Number.parseInt(values.get("time-budget-ms") ?? "900000", 10),
    cacheDir: values.get("cache-dir") ?? join(process.cwd(), ".cache", "knowledge-site"),
    userAgent: values.get("user-agent") ?? DEFAULT_USER_AGENT,
    includeStore: !flags.has("no-store"),
    storeUrl: values.get("store-url") ?? STORE_URL,
    tenantSlug: values.get("tenant") ?? "demo-tenant",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.cacheDir, { recursive: true });

  const rootUrls = args.roots.map((root) => `${DOCS_BASE}/${root}/`);
  console.log(`Обход: ${rootUrls.length} корневых разделов, глубина ${args.maxDepth}, пауза ${args.delayMs} мс`);

  const report = await crawlSite({
    roots: rootUrls,
    maxDepth: args.maxDepth,
    delayMs: args.delayMs,
    userAgent: args.userAgent,
    cacheDir: args.cacheDir,
    timeBudgetMs: args.timeBudgetMs,
  });

  console.log(
    `Обход завершён: просмотрено ${report.visited}, из кэша ${report.cached}, ошибок ${report.failed}, причина остановки ${report.stoppedReason}`,
  );
  if (report.stoppedAtUrl) {
    console.log(`Остановка на ${report.stoppedAtUrl} (HTTP ${report.stoppedStatus ?? "нет"})`);
  }
  console.log(`Собрано страниц: ${report.pages.length}`);

  const imported = await importCrawledPages(report.pages, {
    tenantSlug: args.tenantSlug,
    extraOrigin: "docs_site",
  });

  console.log(`Импортировано источников: ${imported.sources}, чанков: ${imported.chunks}, ошибок: ${imported.failed}`);

  if (args.includeStore) {
    // Страница магазина — отдельный источник с происхождением store_page.
    const storeReport = await crawlSite({
      roots: [args.storeUrl],
      maxDepth: 0,
      delayMs: args.delayMs,
      userAgent: args.userAgent,
      cacheDir: args.cacheDir,
      timeBudgetMs: args.timeBudgetMs,
    });
    const storeImported = await importCrawledPages(storeReport.pages, {
      tenantSlug: args.tenantSlug,
      extraOrigin: "store_page",
      extraProvenance: "store_page",
    });
    console.log(
      `Магазин: просмотрено ${storeReport.visited}, источников ${storeImported.sources}, чанков ${storeImported.chunks}`,
    );
    imported.sources += storeImported.sources;
    imported.chunks += storeImported.chunks;
    imported.failed += storeImported.failed;
  }

  console.log(`Итого: источников ${imported.sources}, чанков ${imported.chunks}, ошибок ${imported.failed}`);
  process.exit(imported.failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(`Импорт не выполнен: ${(error as Error).message}`);
  process.exit(1);
});
