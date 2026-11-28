import { createElement } from "react";
import { render } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool } from "@/db/pool";
import {
  describeCapabilities,
  readCurrentSettings,
  updateSetting,
} from "@/modules/agent-settings";
import SettingsPage, { metadata } from "@/app/settings/page";
import { signAccessSession, verifyAccessCode } from "@/modules/access/session";
import { ensureSliceDatabase } from "./helpers";

/**
 * Реестр возможностей и честное состояние элементов управления кабинета.
 *
 * Команда проверки:
 * `npm run test -- tests/agent-settings/capabilities.test.ts`
 */

const TENANT_SLUG = "test-agent-capabilities-08";
const MANAGER_CODE = "manager-code-08";
const SESSION_SECRET = "session-secret-08";
const APPROVED_LOGO = resolve(
  process.cwd(),
  "docs/лого софтлайн/Софтлайн-решения+SOFL_Logo_rgb (2).png",
);

/** Cookie менеджера: подписанная сессия кабинета. */
type CookieStore = Map<string, string>;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = (globalThis as { __sl08Cookies?: CookieStore }).__sl08Cookies?.get(
        name,
      );
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

/**
 * Значение cookie кабинета: подписанная сессия доступа.
 *
 * Код один на весь стенд: кабинет открывается той же cookie, что и чат
 * (решение владельца от 28.11.2026).
 */
async function managerCookieValue(): Promise<string> {
  const session = await verifyAccessCode(MANAGER_CODE);
  if (!session) throw new Error("Сессия доступа не выдана");
  return signAccessSession(session);
}

describe("реестр возможностей и кабинет настроек", () => {
  let tenantId = "";

  beforeAll(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
    // Код один на весь стенд: он открывает и чат, и кабинет.
    process.env.ACCESS_CODE = MANAGER_CODE;
    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.TENANT_SLUG = TENANT_SLUG;
  });

  beforeEach(async () => {
    tenantId = await ensureSliceDatabase(TENANT_SLUG);
    process.env.TENANT_SLUG = TENANT_SLUG;
    // Кабинет открыт по умолчанию: cookie доступа подставляется, чтобы
    // проверялась сама форма. Тест закрытого кабинета снимает cookie сам.
    (globalThis as { __sl08Cookies?: CookieStore }).__sl08Cookies = new Map([
      ["support_access", await managerCookieValue()],
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  it("каждый элемент управления имеет признак supported и причину", () => {
    const capabilities = describeCapabilities();

    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      expect(typeof capability.key).toBe("string");
      expect(capability.label.length).toBeGreaterThan(0);
      expect(["toggle", "text", "number", "select"]).toContain(capability.control);
      if (capability.supported) {
        expect(capability.reason).toBeNull();
      } else {
        expect(capability.reason).toBeTruthy();
        expect(capability.reason).toMatch(/не реализовано/i);
      }
    }
  });

  it("поддерживаемые элементы — это настройки с работающим потребителем", () => {
    const supported = describeCapabilities()
      .filter((capability) => capability.supported)
      .map((capability) => capability.key);

    expect(supported.sort()).toEqual(
      [
        "endpoint",
        "max_tokens",
        "model",
        "provider",
        "shadow_mode",
        "system_prompt",
        "temperature",
      ].sort(),
    );
  });

  it("нереализованные элементы помечены причиной", () => {
    const unsupported = describeCapabilities().filter(
      (capability) => !capability.supported,
    );
    const byKey = new Map(unsupported.map((item) => [item.key, item]));

    for (const key of [
      "mcp",
      "skills",
      "promises.schedule",
      "top_p",
      "seed",
      "tools",
      "limits",
    ]) {
      expect(byKey.has(key), `нет элемента ${key}`).toBe(true);
    }
    expect(byKey.get("mcp")?.reason).toMatch(/MCP-клиент/i);
    expect(byKey.get("skills")?.reason).toMatch(/навык/i);
    expect(byKey.get("promises.schedule")?.reason).toMatch(/email|CRM/i);
    expect(byKey.get("top_p")?.reason).toMatch(/top_p/);
    expect(byKey.get("seed")?.reason).toMatch(/seed/);
    expect(byKey.get("tools")?.reason).toMatch(/БЗ|каталог|полномочи/i);
    expect(byKey.get("limits")?.reason).toMatch(/окружени/i);
  });

  it("неподдерживаемый элемент нельзя изменить: попытка возвращает ошибку", async () => {
    await expect(
      updateSetting(tenantId, "skills", "какой-то навык", "manager-08"),
    ).rejects.toThrow(/не реализовано/i);

    const stored = await readCurrentSettings(tenantId);
    expect(stored.version).toBe(1);
  });

  it("поддерживаемая настройка принимается", async () => {
    const updated = await updateSetting(
      tenantId,
      "model",
      "capability-model",
      "manager-08",
    );
    expect(updated.model).toBe("capability-model");
    expect(updated.version).toBe(2);
  });

  it("страница кабинета содержит форму поддерживаемых настроек", async () => {
    const { container } = render(await SettingsPage());

    for (const name of [
      "provider",
      "model",
      "endpoint",
      "system_prompt",
      "temperature",
      "max_tokens",
    ]) {
      const control = container.querySelector(`[name="${name}"]`);
      expect(control, `нет поля ${name}`).not.toBeNull();
      expect(control?.hasAttribute("disabled")).toBe(false);
    }
    expect(container.querySelector('[name="shadow_mode"]')).not.toBeNull();
  });

  it("каждый неподдерживаемый элемент присутствует отключённым с пометкой «не реализовано» и причиной", async () => {
    const { container } = render(await SettingsPage());

    const unsupported = describeCapabilities().filter(
      (capability) => !capability.supported,
    );

    for (const capability of unsupported) {
      const control = container.querySelector(
        `[data-capability="${capability.key}"]`,
      );
      expect(control, `нет элемента ${capability.key}`).not.toBeNull();
      expect(control?.hasAttribute("disabled")).toBe(true);

      const wrapper = control?.closest("[data-capability-row]");
      const text = wrapper?.textContent ?? "";
      expect(text).toContain("не реализовано");
      expect(text).toContain(capability.reason ?? "");
    }
  });

  it("набор отключённых элементов страницы совпадает с реестром", async () => {
    const { container } = render(await SettingsPage());

    const disabledOnPage = Array.from(
      container.querySelectorAll("[data-capability]"),
    )
      .filter((element) => element.hasAttribute("disabled"))
      .map((element) => element.getAttribute("data-capability"))
      .sort();

    const unsupported = describeCapabilities()
      .filter((capability) => !capability.supported)
      .map((capability) => capability.key)
      .sort();

    expect(disabledOnPage).toEqual(unsupported);
  });

  it("в разметке нет hex-цветов, а стили используют только токены", async () => {
    const { container } = render(await SettingsPage());

    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

    const css = await readFile(
      resolve(process.cwd(), "src/app/settings/styles.css"),
      "utf8",
    );
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain("var(--sl-font-sans)");
    expect(css).toContain("var(--sl-bg)");
    expect(css).toContain("var(--sl-surface)");
    expect(css).toContain("var(--sl-text)");
    expect(css).toContain("var(--sl-text-secondary)");
    expect(css).toContain("var(--sl-divider)");
    expect(css).toContain("var(--sl-accent)");
    expect(css).toContain("var(--sl-accent-hover)");
    expect(css).toContain("var(--sl-radius)");
    expect(css).toContain("var(--sl-space-");
    expect(css).toContain("var(--sl-logo-guard)");
  });

  it("логотип кабинета — побайтово утверждённый файл, с размерами и охранным полем", async () => {
    const approved = await readFile(APPROVED_LOGO);
    const cabinetLogo = await readFile(
      resolve(process.cwd(), "src/app/settings/softline-logo.png"),
    );
    const cabinetIcon = await readFile(
      resolve(process.cwd(), "src/app/settings/icon.png"),
    );

    expect(cabinetLogo.equals(approved)).toBe(true);
    expect(cabinetIcon.equals(approved)).toBe(true);

    const { container } = render(await SettingsPage());
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("width")).toBeTruthy();
    expect(image?.getAttribute("height")).toBeTruthy();
  });

  it("заголовок и favicon страницы в бренде", () => {
    expect(String(metadata.title)).toContain("Софтлайн");
    expect(metadata.icons).toBeDefined();
  });

  it("без cookie менеджера кабинет закрыт", async () => {
    (globalThis as { __sl08Cookies?: CookieStore }).__sl08Cookies = new Map();

    const { container } = render(await SettingsPage());

    expect(
      container.querySelector("[data-status]")?.getAttribute("data-status"),
    ).toBe("401");
    expect(container.textContent).toContain("код доступа");
    expect(container.querySelector('[name="model"]')).toBeNull();
  });

  it("с действующей cookie менеджера кабинет открыт", async () => {
    const { container } = render(await SettingsPage());

    expect(container.querySelector('[name="model"]')).not.toBeNull();
  });
});
