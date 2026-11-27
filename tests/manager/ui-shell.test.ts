/**
 * Тесты оболочки кабинета менеджера (`src/app/manager/**`).
 *
 * Проверяются четыре требования владельца к UI-волне:
 * 1) бренд-раскладка — в файлах оболочки нет сырых цветов, только токены;
 * 2) доступность — семантическая разметка, доступные имена, подписи полей, видимый фокус;
 * 3) явные состояния загрузки и ошибки;
 * 4) честность — нереализованные разделы помечены «в работе» и не имитируют работу.
 *
 * Плюс контракт страницы входа: код менеджера уходит JSON-телом на `/api/access`
 * и не попадает ни в разметку, ни в журнал.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ManagerOverviewPage from "@/app/manager/page";
import ManagerLoginPage from "@/app/manager/login/page";
import { ManagerButton } from "@/app/manager/components/managerButton";
import { ManagerCard } from "@/app/manager/components/managerCard";
import { ManagerEmptyState } from "@/app/manager/components/managerEmptyState";
import { ManagerErrorState } from "@/app/manager/components/managerErrorState";
import { ManagerGate } from "@/app/manager/components/managerGate";
import { ManagerLoading } from "@/app/manager/components/managerLoading";
import { ManagerShell } from "@/app/manager/components/managerShell";
import { ManagerTabs } from "@/app/manager/components/managerTabs";
import { MANAGER_SECTIONS } from "@/app/manager/components/managerSections";

/** Текущий путь для `usePathname` — его читает шлюз кабинета. */
const navState = vi.hoisted(() => ({ pathname: "/manager", pushed: [] as string[] }));

vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({
    push: (href: string) => navState.pushed.push(href),
    refresh: () => undefined,
  }),
}));

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
const MANAGER_DIR = resolve(REPO_ROOT, "src/app/manager");
const TOKENS_FILE = resolve(REPO_ROOT, "src/app/styles/tokens.css");

/** Все файлы оболочки: страницы, компоненты и стили. */
function managerFiles(dir: string = MANAGER_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...managerFiles(full));
      continue;
    }
    if (/\.(tsx|ts|css)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("бренд-раскладка оболочки", () => {
  it("в файлах оболочки нет сырых цветов", () => {
    const offenders: string[] = [];

    for (const file of managerFiles()) {
      const text = readFileSync(file, "utf8");
      const hex = text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      const functional = text.match(/\b(?:rgb|rgba|hsl|hsla)\(/g) ?? [];
      if (hex.length > 0 || functional.length > 0) {
        offenders.push(
          `${file.slice(REPO_ROOT.length + 1)}: ${[...hex, ...functional].join(", ")}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it("цвета и шрифт берутся только из токенов", () => {
    const tokens = readFileSync(TOKENS_FILE, "utf8");
    const declared = new Set(
      [...tokens.matchAll(/(--sl-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string),
    );

    // Переменные оболочки живут в своём пространстве `--sl-m-*`: они
    // объявлены в самих файлах и не подменяют общие токены.
    const local = new Map<string, Set<string>>();
    const used = new Set<string>();

    for (const file of managerFiles()) {
      const text = readFileSync(file, "utf8");
      const own = new Set(
        [...text.matchAll(/(--sl-m-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string),
      );
      local.set(file, own);

      for (const match of text.matchAll(/var\((--sl-[a-z0-9-]+)\)/g)) {
        used.add(match[1] as string);
      }
    }

    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      if (name.startsWith("--sl-m-")) {
        // Локальная переменная объявлена в том же файле, где используется.
        const owners = [...local.entries()].filter(([, names]) => names.has(name));
        expect(owners.length, `локальный токен ${name} нигде не объявлен`).toBeGreaterThan(0);
        continue;
      }
      expect(declared.has(name), `токен ${name} не объявлен в tokens.css`).toBe(true);
    }
  });

  it("общие токены не переопределяются в файлах оболочки", () => {
    const tokens = readFileSync(TOKENS_FILE, "utf8");
    const declared = new Set(
      [...tokens.matchAll(/(--sl-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string),
    );

    for (const file of managerFiles()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(--sl-[a-z0-9-]+)\s*:/g)) {
        const name = match[1] as string;
        if (name.startsWith("--sl-m-")) {
          continue;
        }
        expect(declared.has(name), `${name} переопределён в оболочке`).toBe(true);
      }
    }
  });

  it("шрифт задан переменной --sl-font-sans, логотип — с охранным полем", () => {
    const styles = readFileSync(resolve(MANAGER_DIR, "styles.css"), "utf8");

    expect(styles).toContain("var(--sl-font-sans)");
    expect(styles).toContain("var(--sl-logo-guard)");
  });

  it("логотип кабинета — утверждённый вариант из пакета заказчика", () => {
    const approved = resolve(
      REPO_ROOT,
      "docs/лого софтлайн/Софтлайн-решения+SOFL_Logo_rgb (2).png",
    );
    const used = resolve(MANAGER_DIR, "softline-logo.png");

    expect(existsSync(approved)).toBe(true);
    expect(existsSync(used)).toBe(true);
    // Файл логотипа копируется, а не рисуется: побайтовое совпадение с
    // утверждённым файлом из `docs/лого софтлайн/`.
    expect(readFileSync(used)).toEqual(readFileSync(approved));
  });
});

describe("доступность оболочки", () => {
  afterEach(() => {
    navState.pathname = "/manager";
  });

  it("каркас семантический: шапка, навигация и основная область", () => {
    render(createElement(ManagerShell, { children: createElement("p", null, "Содержимое") }));

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /разделы кабинета/i })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /обзор/i })).toBeInTheDocument();
  });

  it("все разделы кабинета присутствуют в навигации", () => {
    render(createElement(ManagerShell, { children: null }));

    for (const section of MANAGER_SECTIONS) {
      expect(screen.getByRole("link", { name: new RegExp(section.label, "i") })).toBeInTheDocument();
    }
  });

  it("состав разделов совпадает с замыслом кабинета", () => {
    expect(MANAGER_SECTIONS.map((section) => section.id)).toEqual([
      "overview",
      "queue",
      "knowledge",
      "agent",
      "analytics",
      "sandbox",
    ]);
  });

  it("у кнопки есть доступное имя и явный тип", () => {
    render(
      createElement(
        ManagerButton,
        { children: "Отправить" },
      ),
    );

    const button = screen.getByRole("button", { name: "Отправить" });
    expect(button).toHaveAttribute("type", "button");
  });

  it("у поля кода менеджера есть подпись", () => {
    render(createElement(ManagerLoginPage));

    const input = screen.getByLabelText(/код менеджера/i);
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("name", "code");
  });

  it("фокус виден на интерактивных элементах", () => {
    const styles = readFileSync(resolve(MANAGER_DIR, "styles.css"), "utf8");

    expect(styles).toContain(":focus-visible");
    expect(styles).toMatch(/outline:[^;]*var\(--sl-accent\)/);
  });
});

describe("вкладки оболочки", () => {
  it("полоса вкладок объявлена как tablist, вкладки — как tab", () => {
    render(
      createElement(ManagerTabs, {
        tabs: [
          { id: "one", label: "Первый", href: "/manager/one" },
          { id: "two", label: "Второй", disabled: true, badge: "в работе" },
        ],
        activeId: "one",
        label: "Разделы кабинета",
      }),
    );

    expect(screen.getByRole("tablist", { name: "Разделы кабинета" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-disabled", "true");
    expect(tabs[1]).toBeDisabled();
    expect(tabs[1]).toHaveTextContent("в работе");
  });

  it("выключенная вкладка никуда не ведёт и не получает адрес", () => {
    render(
      createElement(ManagerTabs, {
        tabs: [{ id: "one", label: "Первый", href: "/manager/one", disabled: true }],
        activeId: "one",
        label: "Разделы кабинета",
      }),
    );

    const tab = screen.getByRole("tab");
    expect(tab.tagName).toBe("BUTTON");
    expect(tab).toBeDisabled();
    expect(tab).not.toHaveAttribute("href");
  });

  it("вкладки достижимы с клавиатуры: стрелки переключают фокус", () => {
    render(
      createElement(ManagerTabs, {
        tabs: [
          { id: "one", label: "Первый", href: "/manager/one" },
          { id: "two", label: "Второй", href: "/manager/two" },
        ],
        activeId: "one",
        label: "Разделы кабинета",
      }),
    );

    const tabs = screen.getAllByRole("tab");
    tabs[0]?.focus();
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });

    expect(document.activeElement).toBe(tabs[1]);
  });
});

describe("явные состояния оболочки", () => {
  it("состояние загрузки объявлено для assistive-технологий", () => {
    render(createElement(ManagerLoading, { label: "Загружаем очередь" }));

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Загружаем очередь");
  });

  it("состояние ошибки объявлено тревожным сообщением", () => {
    render(createElement(ManagerErrorState, { title: "Очередь недоступна", description: "Повторите позже" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Очередь недоступна");
    expect(alert).toHaveTextContent("Повторите позже");
  });

  it("пустое состояние объясняет, что данных нет", () => {
    render(createElement(ManagerEmptyState, { title: "Обращений нет", description: "Пока никто не написал" }));

    expect(screen.getByText("Обращений нет")).toBeInTheDocument();
    expect(screen.getByText("Пока никто не написал")).toBeInTheDocument();
  });
});

describe("честность нереализованных разделов", () => {
  it("неготовые разделы помечены «в работе» и ведут на честное состояние", () => {
    render(createElement(ManagerOverviewPage));

    const pending = MANAGER_SECTIONS.filter((section) => section.status === "in-progress");

    for (const section of pending) {
      expect(screen.getByText(new RegExp(`^${section.label}$`, "i"))).toBeInTheDocument();
      // Якоря честного состояния существуют: переход по пункту навигации
      // приводит к карточке «раздел в работе», а не в заглушку с данными.
      const anchor = document.querySelector(`#${section.anchor}`);
      expect(anchor, `нет якоря ${section.anchor}`).not.toBeNull();
      expect(anchor?.textContent).toMatch(/раздел в работе/i);
    }
  });

  it("в навигации неготовые пункты подписаны и ведут на честное состояние", () => {
    render(createElement(ManagerShell, { children: null }));

    for (const section of MANAGER_SECTIONS) {
      const link = screen.getByRole("link", { name: new RegExp(section.label, "i") });
      expect(link).toHaveAttribute("data-status", section.status);
      if (section.status === "in-progress") {
        // Пункт есть и подписан, но ведёт на карточку честного состояния
        // обзора, а не на несуществующую страницу раздела.
        expect(link.textContent).toMatch(/в работе/i);
        expect(link).toHaveAttribute("href", `/manager#${section.anchor}`);
      } else {
        expect(link).toHaveAttribute("href", section.href);
      }
    }
  });

  it("карточка неготового раздела не предлагает действий, которые ничего не делают", () => {
    render(createElement(ManagerOverviewPage));

    // Кнопка «Открыть раздел» есть только у готовых разделов, и у них она
    // работает; у неготовых её нет вовсе, чтобы не предлагать действие,
    // которое ничего не делает.
    const buttons = screen.queryAllByRole("button", { name: /открыть раздел/i });
    for (const button of buttons) {
      expect(button).not.toBeDisabled();
    }
  });
});

describe("шлюз доступа к кабинету", () => {
  afterEach(() => {
    navState.pathname = "/manager";
  });

  it("без менеджерской cookie кабинет не открывается", () => {
    render(
      createElement(ManagerGate, {
        authorized: false,
        children: createElement("p", null, "Секретный обзор"),
      }),
    );

    expect(screen.getByRole("heading", { name: /требуется вход менеджера/i })).toBeInTheDocument();
    expect(screen.queryByText("Секретный обзор")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /войти/i })).toHaveAttribute("href", "/manager/login");
  });

  it("с менеджерской cookie кабинет открывается", () => {
    render(
      createElement(ManagerGate, {
        authorized: true,
        children: createElement("p", null, "Секретный обзор"),
      }),
    );

    expect(screen.getByText("Секретный обзор")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /требуется вход менеджера/i })).not.toBeInTheDocument();
  });

  it("страница входа показывается без шлюза", () => {
    navState.pathname = "/manager/login";

    render(
      createElement(ManagerGate, {
        authorized: false,
        children: createElement(ManagerLoginPage),
      }),
    );

    expect(screen.getByLabelText(/код менеджера/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /требуется вход менеджера/i })).not.toBeInTheDocument();
  });

  it("каркас читает cookie доступа через барьер доступа", () => {
    const layout = readFileSync(resolve(MANAGER_DIR, "layout.tsx"), "utf8");

    expect(layout).toContain("checkManagerAccess");
    expect(layout).toContain("cookies()");
  });
});

describe("страница входа менеджера", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    navState.pathname = "/manager/login";
    navState.pushed = [];
  });

  it("отправляет код доступа JSON-телом на /api/access и не логирует его", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ session_id: "session-1", expires_at: "2026-12-01T00:00:00.000Z" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    render(createElement(ManagerLoginPage));

    const input = screen.getByLabelText(/код менеджера/i);
    fireEvent.change(input, { target: { value: "manager-secret-code" } });
    fireEvent.click(screen.getByRole("button", { name: /войти в кабинет/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/access");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toContain("application/json");

    const body = JSON.parse(String(init.body)) as { code?: string; manager?: boolean };
    expect(body.code).toBe("manager-secret-code");
    // Код один на весь стенд: отдельного режима входа в кабинет нет.
    expect(body.manager).toBeUndefined();

    const written = [logSpy, warnSpy, errorSpy, infoSpy]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg) => String(arg)).join(" "))
      .join("\n");
    expect(written).not.toContain("manager-secret-code");
    expect(screen.queryByText("manager-secret-code")).not.toBeInTheDocument();

    // После успешной проверки менеджер попадает в кабинет, а код из поля
    // ввода убирается — в DOM его не остаётся.
    await waitFor(() => expect(navState.pushed).toContain("/manager"));
    expect(screen.queryByDisplayValue("manager-secret-code")).not.toBeInTheDocument();
  });

  it("при отказе сервера показывает понятную ошибку и не раскрывает код", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "Код доступа не принят" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(ManagerLoginPage));

    fireEvent.change(screen.getByLabelText(/код менеджера/i), {
      target: { value: "manager-secret-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: /войти в кабинет/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/не принят/i);
    expect(alert.textContent).not.toContain("manager-secret-code");
    // Неверный код не остаётся в поле ввода.
    expect(screen.queryByDisplayValue("manager-secret-code")).not.toBeInTheDocument();
  });

  it("во время проверки кода показывает состояние загрузки", async () => {
    // Ответ сервера задерживается, чтобы состояние загрузки было видно.
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await pending;
      return new Response(JSON.stringify({ session_id: "session-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(ManagerLoginPage));

    fireEvent.change(screen.getByLabelText(/код менеджера/i), {
      target: { value: "manager-secret-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: /войти в кабинет/i }));

    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /войти в кабинет/i })).toBeDisabled();

    release();
  });
});
