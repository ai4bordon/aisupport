/**
 * Гигиена тестовой оснастки: находки B13 и B14 аудита.
 *
 * B13: интеграционные проверки не должны молча пропускаться, когда
 * `DATABASE_URL` не задан. Конфиг обязан задавать тестовую строку подключения,
 * и проверка обязана выполняться, а не выглядеть «прошедшей».
 *
 * B14: тесты не должны переписывать общий `process.env`. Из-за этого файл,
 * идущий после соседнего, наследовал чужое окружение (чужую базу, чужого
 * арендатора), и результат прогона зависел от порядка файлов.
 *
 * Проверки выполняются дочерним прогоном Vitest: два файла запускаются в
 * общем воркере (`--no-isolate`), поэтому мутация общего окружения видна
 * следующему файлу так же, как в последовательном прогоне.
 *
 * Пробы лежат вне `tests/`, чтобы дочерний прогон не подхватывал их сам,
 * а основной прогон репозитория не видел их как тесты.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const PROBE_DIR = resolve(REPO_ROOT, ".scratch/audit-hygiene-probe");
const PROBE_REL = relative(REPO_ROOT, PROBE_DIR).split("\\").join("/");
const VITEST_BIN = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");

/** Тестовая база по умолчанию: та же строка, что и в `vitest.config.ts`. */
const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/support_agent";

/** Арендатор пробы: уникальный, чтобы не задевать чужие данные. */
const PROBE_TENANT = "audit-hygiene-probe";

/**
 * Проба «пропуск не выглядит как успех»: строка подключения читается на
 * верхнем уровне модуля — так же, как в интеграционных проверках, — и блок
 * помечен `skipIf`. Если переменная окружения не дошла до теста, блок
 * пропускается и прогон остаётся зелёным.
 */
const GUARD_PROBE = `const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("проверка не пропущена молча", () => {
  it("строка подключения дошла до теста", () => {
    expect(databaseUrl).toBe("${DEFAULT_DATABASE_URL}");
  });
});
`;

/**
 * Проба «конфиг задаёт строку подключения»: переменной в окружении процесса
 * нет, значение обязано прийти из конфига.
 */
const ENV_PROBE = `import { expect, it } from "vitest";

it("строка подключения пришла из конфига", () => {
  expect(process.env.DATABASE_URL).toBe("${DEFAULT_DATABASE_URL}");
});
`;

/**
 * Проба «помощник не оставляет мутации»: подготовка базы меняет арендатора,
 * а следующий файл обязан увидеть чистое окружение.
 */
const MUTATOR_PROBE = `import { expect, it } from "vitest";
import { ensureDatabase } from "../../tests/limits/helpers";

it("подготовка пробы готовит базу", async () => {
  try {
    await ensureDatabase("${PROBE_TENANT}");
  } catch {
    // База может быть недоступна: проверка ниже всё равно смотрит на
    // состояние общего окружения, а не на результат подключения.
  }
  expect(process.env.TENANT_SLUG).toBe("${PROBE_TENANT}");
});
`;

/** Проба «соседний файл не наследует мутацию». */
const CHECKER_PROBE = `import { expect, it } from "vitest";

it("общее окружение не изменено соседним файлом", () => {
  expect(process.env.TENANT_SLUG).toBeUndefined();
});
`;

type ProbeReport = {
  total: number;
  failed: number;
  skipped: number;
  results: string[];
};

type JsonReport = {
  numTotalTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: Array<{
    assertionResults?: Array<{ status?: string; title?: string }>;
  }>;
};

/**
 * Запускает дочерний прогон Vitest и читает JSON-отчёт.
 *
 * Ошибка дочернего процесса ожидаема на «красном» прогоне: падение пробы —
 * часть проверки, её статус разбирается по отчёту.
 */
async function runProbe(files: string[], reportName: string): Promise<ProbeReport> {
  const outputFile = resolve(PROBE_DIR, `${reportName}.json`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Переменной нет намеренно: строка подключения обязана прийти из конфига.
  delete env.DATABASE_URL;

  try {
    execFileSync(
      process.execPath,
      [
        VITEST_BIN,
        "run",
        "--config",
        resolve(PROBE_DIR, "vitest.probe.config.ts"),
        "--no-isolate",
        "--pool=forks",
        "--maxWorkers=1",
        "--reporter=json",
        `--outputFile=${outputFile}`,
        ...files,
      ],
      { cwd: REPO_ROOT, env, stdio: "pipe", timeout: 240_000 },
    );
  } catch {
    // Падение дочернего прогона — часть проверки: статус разбирается ниже.
  }

  const report = JSON.parse(await readFile(outputFile, "utf8")) as JsonReport;
  const assertions = (report.testResults ?? []).flatMap(
    (file) => file.assertionResults ?? [],
  );
  return {
    total: report.numTotalTests ?? assertions.length,
    failed:
      report.numFailedTests ??
      assertions.filter((assertion) => assertion.status === "failed").length,
    skipped:
      report.numPendingTests ??
      assertions.filter((assertion) => assertion.status === "pending").length,
    results: assertions
      .map((assertion) => `${assertion.status ?? "unknown"}: ${assertion.title ?? ""}`)
      .sort(),
  };
}

describe("гигиена тестовой оснастки (аудит B13, B14)", () => {
  beforeAll(async () => {
    await rm(PROBE_DIR, { recursive: true, force: true });
    await mkdir(PROBE_DIR, { recursive: true });
    await writeFile(
      resolve(PROBE_DIR, "vitest.probe.config.ts"),
      [
        `import base from "../../vitest.config";`,
        ``,
        `export default {`,
        `  ...base,`,
        `  test: {`,
        `    ...base.test,`,
        `    environment: "node",`,
        `    include: ["${PROBE_REL}/*.test.ts"],`,
        `  },`,
        `};`,
        ``,
      ].join("\n"),
      "utf8",
    );
    await writeFile(resolve(PROBE_DIR, "guard.test.ts"), GUARD_PROBE, "utf8");
    await writeFile(resolve(PROBE_DIR, "env.test.ts"), ENV_PROBE, "utf8");
    await writeFile(resolve(PROBE_DIR, "a-mutator.test.ts"), MUTATOR_PROBE, "utf8");
    await writeFile(resolve(PROBE_DIR, "b-checker.test.ts"), CHECKER_PROBE, "utf8");
    await writeFile(resolve(PROBE_DIR, "a-checker.test.ts"), CHECKER_PROBE, "utf8");
    await writeFile(resolve(PROBE_DIR, "b-mutator.test.ts"), MUTATOR_PROBE, "utf8");
  });

  afterAll(async () => {
    await rm(PROBE_DIR, { recursive: true, force: true });
  });

  it("конфиг задаёт строку подключения, когда переменной нет", async () => {
    const report = await runProbe(["env.test.ts"], "env");

    expect(report.total).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.failed).toBe(0);
  });

  it("пропуск проверки не выглядит как успех", async () => {
    const report = await runProbe(["guard.test.ts"], "guard");

    expect(report.total).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.failed).toBe(0);
  });

  it("помощники не переключают общую строку подключения", async () => {
    for (const file of ["tests/db/helpers.ts", "tests/limits/helpers.ts"]) {
      const source = await readFile(resolve(REPO_ROOT, file), "utf8");
      expect(source).not.toMatch(
        /process\.env(?:\.DATABASE_URL|\[\s*["']DATABASE_URL["']\s*\])\s*=/,
      );
    }
  });

  it(
    "порядок файлов не влияет на результат прогона",
    async () => {
      const mutatorFirst = await runProbe(
        ["a-mutator.test.ts", "b-checker.test.ts"],
        "mutator-first",
      );
      const checkerFirst = await runProbe(
        ["a-checker.test.ts", "b-mutator.test.ts"],
        "checker-first",
      );

      // Ни один файл не пропускается молча.
      expect(mutatorFirst.skipped).toBe(0);
      expect(checkerFirst.skipped).toBe(0);
      expect(mutatorFirst.total).toBe(2);
      expect(checkerFirst.total).toBe(2);

      // Мутация общего окружения не доходит до соседнего файла.
      expect(mutatorFirst.failed).toBe(0);
      expect(checkerFirst.failed).toBe(0);

      // Порядок файлов не меняет результат прогона.
      expect(mutatorFirst.results).toEqual(checkerFirst.results);
    },
    300_000,
  );
});
