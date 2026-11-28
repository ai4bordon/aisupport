/**
 * Мобильная ширина разделов «Агент» и «Песочница» (`src/app/manager/**`).
 *
 * Проверяются правила, по которым страница помещается в 390 пикселей:
 * 1) ни у одного блока раздела нет фиксированной ширины — она распирает
 *    страницу, и на телефоне появляется горизонтальный скролл;
 * 2) таблицы истории и аудита прокручиваются внутри своей области, а не
 *    растягивают страницу;
 * 3) для узкого экрана есть отдельные правила.
 *
 * Проверка идёт по файлам стилей: разметка и правила разъедутся только
 * при правке CSS, а её ловит именно этот тест.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Корень репозитория ищется от файла теста вверх до папки с `package.json`
 * и каталогом `docs`: глубина вложенности теста разная (корень репозитория
 * и worktree среза), поэтому фиксированное число уровней вверх не подходит.
 */
function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      existsSync(resolve(current, "package.json")) &&
      existsSync(resolve(current, "docs"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Корень репозитория не найден выше tests/manager");
    }
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot();
const AGENT_STYLES = readFileSync(
  resolve(REPO_ROOT, "src/app/manager/agent/styles.css"),
  "utf8",
);
const SANDBOX_STYLES = readFileSync(
  resolve(REPO_ROOT, "src/app/manager/sandbox/styles.css"),
  "utf8",
);

describe("мобильная ширина разделов кабинета", () => {
  it("в стилях разделов нет фиксированной ширины блоков", () => {
    for (const [name, styles] of [
      ["агент", AGENT_STYLES],
      ["песочница", SANDBOX_STYLES],
    ] as const) {
      expect(
        styles,
        `в стилях раздела «${name}» есть фиксированная ширина`,
      ).not.toMatch(/(?<!max-)width:\s*\d{3,}px/);
      expect(
        styles,
        `в стилях раздела «${name}» есть фиксированная минимальная ширина`,
      ).not.toMatch(/min-width:\s*\d{3,}px/);
    }
  });

  it("оба раздела считают размеры по границе рамки", () => {
    expect(AGENT_STYLES).toMatch(/box-sizing:\s*border-box/);
    expect(SANDBOX_STYLES).toMatch(/box-sizing:\s*border-box/);
  });

  it("таблицы истории и аудита прокручиваются внутри своей области", () => {
    expect(AGENT_STYLES).toMatch(/\.sl-agent-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(AGENT_STYLES).toMatch(/\.sl-agent-table-scroll\s*\{[^}]*max-width:\s*100%/);
  });

  it("для узкого экрана есть отдельные правила", () => {
    expect(AGENT_STYLES).toMatch(/@media \(max-width: 640px\)/);
    expect(SANDBOX_STYLES).toMatch(/@media \(max-width: 640px\)/);
  });

  it("в стилях разделов нет сырых цветов", () => {
    for (const styles of [AGENT_STYLES, SANDBOX_STYLES]) {
      expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(styles).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
      expect(styles).toContain("var(--sl-");
    }
  });
});
