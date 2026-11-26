// Запуск импорта фида из командной строки.
//
// Импорт запускается вручную, раз в сутки: планировщика, cron и фоновой
// задачи в прототипе нет. Скрипт печатает отчёт с датой фида и хешем снимка
// и завершается с ненулевым кодом, если в отчёте есть ошибки записи.
import {
  importFeed,
  inspectFeed,
  LIVE_FEED_URL,
  type ImportReport,
  type InspectReport,
} from "../src/import/catalog/index.js";

type CliOptions = {
  sourceUrl: string | null;
  fallback: string | null;
  tenantSlug: string;
  sourcePath: string | null;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sourceUrl: null,
    fallback: null,
    tenantSlug: "demo-tenant",
    sourcePath: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--source-url" && next) {
      options.sourceUrl = next;
      index += 1;
    } else if (arg === "--fallback" && next) {
      options.fallback = next;
      index += 1;
    } else if (arg === "--tenant" && next) {
      options.tenantSlug = next;
      index += 1;
    } else if (arg === "--source" && next) {
      options.sourcePath = next;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }
  return options;
}

function printReport(report: ImportReport): void {
  console.log("=== Импорт фида каталога ===");
  console.log(`источник:      ${report.sourceKind === "live_feed" ? report.sourceUrl : "локальный снимок"}`);
  console.log(`дата фида:     ${report.feedDate ?? "не указана"}`);
  console.log(`хеш снимка:    ${report.snapshotHash}`);
  console.log(`снимок:        ${report.snapshotId}`);
  console.log(`позиций:       ${report.total}`);
  console.log(`записано:      ${report.imported}`);
  console.log(`пропущено:     ${report.skipped}`);
  console.log(`ошибок:        ${report.failed}`);
  console.log(`категорий:     ${report.categories}`);
  console.log(`available:     ${report.availableCount}`);
  console.log(`с ценой > 0:   ${report.pricedCount}`);
  console.log(`имён параметров: ${report.paramNames}`);
  console.log(`значений параметров: ${report.paramValues}`);
  console.log(`длительность:  ${report.durationMs} мс`);
}

function printInspectReport(report: InspectReport): void {
  console.log("=== Проверка фида каталога (запись в базу не выполнялась) ===");
  console.log(`источник:      ${report.sourceKind === "live_feed" ? report.sourceUrl : "локальный снимок"}`);
  console.log(`дата фида:     ${report.feedDate ?? "не указана"}`);
  console.log(`хеш снимка:    ${report.snapshotHash}`);
  console.log(`позиций:       ${report.total}`);
  console.log(`пропущено:     ${report.skipped}`);
  console.log(`ошибок:        ${report.failed}`);
  console.log(`категорий:     ${report.categories}`);
  console.log(`available:     ${report.availableCount}`);
  console.log(`с ценой > 0:   ${report.pricedCount}`);
  console.log(`имён параметров: ${report.paramNames}`);
  console.log(`значений параметров: ${report.paramValues}`);
  console.log(`длительность:  ${report.durationMs} мс`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    const report = await inspectFeed(
      options.sourcePath ?? options.sourceUrl ?? LIVE_FEED_URL,
      options.fallback,
    );
    printInspectReport(report);
    return;
  }

  const report = options.sourcePath
    ? await importFeed(options.sourcePath, { tenantSlug: options.tenantSlug })
    : await importFeed(options.sourceUrl ?? LIVE_FEED_URL, {
        tenantSlug: options.tenantSlug,
        fallbackPath: options.fallback,
      });

  printReport(report);
  if (report.failed > 0) {
    console.error(`импорт завершился с ошибками записи: ${report.failed}`);
    process.exitCode = 1;
  }
}

await main();
