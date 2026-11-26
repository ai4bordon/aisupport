#!/usr/bin/env node
// Проверка границ срезов: каждый агент меняет файлы только в своём каталоге.
// Запуск: node docs/check-slice-boundaries.mjs
import { execSync } from "node:child_process";

const slices = [
  { name: "01", branch: "slice/01-core-web-chat", base: "main",
    allowed: ["src/core/", "src/db/", "src/contracts/", "src/app/api/chat/", "src/app/api/agent/",
      "src/app/api/health/", "src/app/api/kb/", "src/app/widget/", "src/modules/knowledge/index.ts",
      "src/modules/knowledge/search.ts", "src/modules/policy/", "src/modules/telemetry/",
      "db/migrations/1", "tests/db/", "tests/core/", "tests/knowledge/search.test.ts", "tests/api/",
      "tests/integration/01-web-chat-kb-escalation.test.ts"] },
  { name: "02", branch: "slice/02-quote-invoice", base: "main",
    allowed: ["src/modules/documents/", "src/app/api/docs/", "db/migrations/3000_templates_documents.sql",
      "tests/documents/", "tests/integration/02-quote-invoice.test.ts"] },
  { name: "05", branch: "slice/05-max-polling", base: "main",
    allowed: ["src/channels/max/", "src/app/api/max/", "db/migrations/5000_channel_state.sql",
      "tests/channels/max/", "tests/integration/05-max-polling-adapter.test.ts"] },
  { name: "11", branch: "slice/11-access-guard", base: "main",
    allowed: ["src/modules/access/", "src/modules/limits/", "src/app/access/", "src/app/api/access/",
      "db/migrations/4000_usage_counters.sql", "tests/access/", "tests/limits/",
      "tests/integration/11-public-demo-access.test.ts"] },
  { name: "12", branch: "slice/12-import-feed", base: "main",
    allowed: ["src/import/catalog/", "src/modules/catalog/", "scripts/import-feed.ts",
      "db/migrations/1000_catalog.sql", "db/migrations/1010_clients_orders_licenses.sql",
      "db/migrations/1020_catalog_snapshots.sql", "tests/catalog/",
      "tests/integration/12-import-catalog-feed.test.ts"] },
  { name: "13", branch: "slice/13-import-knowledge", base: "main",
    allowed: ["src/import/knowledge/", "scripts/import-docs.ts", "db/migrations/2000_kb_sources.sql",
      "tests/knowledge/import.test.ts", "tests/knowledge/chunk.test.ts",
      "tests/integration/13-import-knowledge-site.test.ts"] },
];

// Файлы, которые правит только exec: общие поверхности.
const execOwned = [
  "package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "vitest.config.ts",
  "src/app/styles/tokens.css", "docs/api-contract.md", "docs/data-model.md",
  "docs/plans/", "docs/", ".gitignore", "db/README.md",
];

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

let problems = 0;
for (const slice of slices) {
  const cwd = `C:/Users/Kerry/Desktop/MyWork/HACKATON/my_project/.worktrees/${slice.name === "01" ? "01-core-web-chat" : slice.name === "02" ? "02-quote-invoice" : slice.name === "05" ? "05-max-polling" : slice.name === "11" ? "11-access-guard" : slice.name === "12" ? "12-import-feed" : "13-import-knowledge"}`;
  let files;
  try {
    files = git(`diff --name-only ${slice.base}...${slice.branch}`, cwd).split("\n").filter(Boolean);
  } catch {
    console.log(`\n=== срез ${slice.name} === ветка без коммитов — пропускаю`);
    continue;
  }
  const outside = files.filter((f) => {
    if (execOwned.some((e) => f === e || f.startsWith(e))) return false;
    return !slice.allowed.some((a) => f === a || f.startsWith(a));
  });
  const commits = git(`log --oneline ${slice.base}..${slice.branch}`, cwd).split("\n").filter(Boolean);
  console.log(`\n=== срез ${slice.name} (${slice.branch}) ===`);
  console.log(`коммитов: ${commits.length}, файлов: ${files.length}`);
  if (outside.length) {
    problems += outside.length;
    console.log(`ВНЕ КАТАЛОГА СРЕЗА (${outside.length}):`);
    for (const f of outside) console.log(`  ${f}`);
  } else {
    console.log("границы соблюдены");
  }
}

console.log(`\nитого нарушений границ: ${problems}`);
process.exit(problems ? 1 : 0);
