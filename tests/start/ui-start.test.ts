import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as maxFeedGet } from "@/app/api/demo/max-feed/route";
import { BOT_LINK } from "@/app/start/max-bot";
import { MaxFeed } from "@/app/start/max-tab";
import { buildQrMatrix } from "@/app/start/qr-matrix";
import { StartScreen } from "@/app/start/start-screen";
import { default as StartPage } from "@/app/start/page";
import { closePool } from "@/db/pool";
import { buildAccessCookie, verifyAccessCode } from "@/modules/access/session";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Тесты единого экрана демо `/start`.
 *
 * Экран состоит из трёх вкладок (Веб-чат, MAX, Админка) и живой ленты MAX
 * `GET /api/demo/max-feed`. Проверяются: фирменная раскладка (только токены),
 * порядок вкладок и состояние в URL, ленивая загрузка, клавиатурная
 * навигация, контраст, состояния загрузки/ошибки/пустоты и то, что лента
 * отдаёт только маскированный текст.
 */

/** Корень репозитория ищется от файла теста вверх до папки с `package.json`. */
function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    current = dirname(current);
  }
  throw new Error("Корень репозитория не найден");
}

const REPO_ROOT = findRepoRoot();

const START_DIR = resolve(REPO_ROOT, "src/app/start");
const TOKENS_FILE = resolve(REPO_ROOT, "src/app/styles/tokens.css");
const MAX_FEED_ROUTE = resolve(REPO_ROOT, "src/app/api/demo/max-feed/route.ts");

/** Барьер доступа подменяется: страница проверяется как UI, барьер — тестами среза доступа. */
const checkAccessMock = vi.hoisted(() =>
  vi.fn(async () => ({
    allowed: true as boolean,
    reason: "ok" as string,
    retryAfterSeconds: null as number | null,
  })),
);

vi.mock("@/modules/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access")>();
  return { ...actual, checkAccess: checkAccessMock };
});

/** Заголовки запроса подменяются: `next/headers` вне запроса недоступен. */
const headersMock = vi.hoisted(() =>
  vi.fn(async () => new Headers({ host: "localhost:3000", "x-forwarded-for": "203.0.113.9" })),
);

vi.mock("next/headers", () => ({ headers: headersMock }));

const TENANT_SLUG = "test-ui-start";
const ACCESS_CODE = "demo-test-code-ui-start";
const SESSION_SECRET = "demo-test-secret-ui-start";

type FeedMessage = {
  text_masked: string;
  role: string;
  created_at: string;
  conversation_id: string;
};

type FeedResponse = {
  bot: { username: string; link: string };
  status: {
    published: boolean;
    worker_listening: boolean;
    marker: number | null;
    last_event_at: string | null;
    shadow_mode: boolean;
  };
  messages: FeedMessage[];
  empty: boolean;
};

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** Относительный путь файла от корня репозитория — для читаемых сообщений. */
function relative(file: string): string {
  return file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
}

/** Значение переменной из `tokens.css`. */
async function tokenValue(name: string): Promise<string> {
  const tokens = await readFile(TOKENS_FILE, "utf8");
  const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(tokens);
  if (!match?.[1]) throw new Error(`Токен ${name} не найден`);
  return match[1];
}

/**
 * Контраст по WCAG 2.1 между двумя hex-цветами.
 *
 * Расчёт прямо в тесте: сверка с внешней библиотекой не нужна, а значения
 * токенов и так известны из `tokens.css`.
 */
function contrastRatio(left: string, right: string): number {
  const channel = (value: string): number => {
    const part = Number.parseInt(value, 16) / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (value: string): number => {
    const r = channel(value.slice(0, 2));
    const g = channel(value.slice(2, 4));
    const b = channel(value.slice(4, 6));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(left.replace("#", ""));
  const b = luminance(right.replace("#", ""));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("генератор QR-кода для ссылки на бота", () => {
  it("строит читаемый код со ссылкой на бота MAX", () => {
    const matrix = buildQrMatrix(BOT_LINK);

    expect(matrix.size).toBeGreaterThanOrEqual(21);
    // Поисковые узоры по трём углам обязаны быть на месте.
    const isDark = (row: number, col: number): boolean =>
      matrix.modules[row * matrix.size + col] ?? false;
    expect(isDark(0, 0)).toBe(true);
    expect(isDark(1, 1)).toBe(false);
    expect(isDark(0, matrix.size - 7)).toBe(true);
    expect(isDark(matrix.size - 7, 0)).toBe(true);
  });

  it("различает разные ссылки: код зависит от содержимого", () => {
    const first = buildQrMatrix(BOT_LINK);
    const second = buildQrMatrix("https://max.ru/id381710832195_1_bot");

    expect(first.size).toBe(second.size);
    const differing = first.modules.filter(
      (value, index) => value !== second.modules[index],
    ).length;
    expect(differing).toBeGreaterThan(0);
  });
});

describe("экран демо /start — фирменная раскладка", () => {
  it("в файлах экрана нет сырых цветов: только переменные токенов", async () => {
    const files = [...(await listFiles(START_DIR)), MAX_FEED_ROUTE];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const hexes = content.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes, `${relative(file)}: найдены сырые hex-цвета ${hexes.join(", ")}`).toEqual(
        [],
      );
      expect(content.match(/\brgba?\(/g) ?? [], `${relative(file)}: найден rgb()`).toEqual([]);
      expect(content.match(/\bhsla?\(/g) ?? [], `${relative(file)}: найден hsl()`).toEqual([]);
    }
  });

  it("использует только переменные из tokens.css и объявленные в своих стилях", async () => {
    const tokens = await readFile(TOKENS_FILE, "utf8");
    const known = new Set(
      [...tokens.matchAll(/(--sl-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string),
    );
    expect(known.size).toBeGreaterThan(10);

    const styles = await readFile(join(START_DIR, "styles.css"), "utf8");
    const local = new Set(
      [...styles.matchAll(/(--sl-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string),
    );

    const files = [...(await listFiles(START_DIR)), MAX_FEED_ROUTE];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const used = [...content.matchAll(/var\((--[a-z0-9-]+)/g)].map(
        (match) => match[1] as string,
      );
      for (const name of used) {
        expect(
          known.has(name) || local.has(name),
          `${relative(file)}: неизвестная переменная ${name}`,
        ).toBe(true);
      }
    }
  });

  it("подключает логотип с охранным полем не меньше высоты логотипа", async () => {
    const styles = await readFile(join(START_DIR, "styles.css"), "utf8");
    expect(styles).toContain("--sl-logo-guard");
    expect(styles).toMatch(/max\(\s*var\(--sl-logo-guard\)/);
    expect(styles).toContain("--sl-start-logo-height");

    const header = await readFile(join(START_DIR, "brand-header.tsx"), "utf8");
    expect(header).toContain("softline-logo.png");
    expect(header).toContain("alt=");
  });

  it("держит шрифт Montserrat и светлую тему палитры UI-kit", async () => {
    const styles = await readFile(join(START_DIR, "styles.css"), "utf8");
    expect(styles).toContain("var(--sl-font-sans)");
    expect(styles).toContain("var(--sl-bg)");
    expect(styles).toContain("var(--sl-surface)");

    const tokens = await readFile(TOKENS_FILE, "utf8");
    expect(tokens).toMatch(/--sl-font-sans:\s*"Montserrat"/);
  });

  it("обеспечивает достаточный контраст текста на фоне", async () => {
    const text = await tokenValue("--sl-text");
    const secondary = await tokenValue("--sl-text-secondary");
    const surface = await tokenValue("--sl-surface");
    const accent = await tokenValue("--sl-accent");

    expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(secondary, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(surface, accent)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("экран демо /start — вкладки", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/start");
    checkAccessMock.mockResolvedValue({
      allowed: true,
      reason: "ok",
      retryAfterSeconds: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("показывает три вкладки в утверждённом порядке", () => {
    render(createElement(StartScreen, { initialTab: "chat", origin: "http://localhost:3000" }));

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Веб-чат",
      "MAX",
      "Админка",
    ]);
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("монтирует содержимое только активной вкладки", async () => {
    render(createElement(StartScreen, { initialTab: "chat", origin: "http://localhost:3000" }));

    expect(screen.getByText(/встроить на сайт клиента/i)).toBeTruthy();
    expect(screen.queryByText(/se15151074_bot/)).toBeNull();
    expect(screen.queryByText(/кабинет менеджера/i)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "MAX" }));

    await waitFor(() => {
      expect(screen.getByText(/se15151074_bot/)).toBeTruthy();
    });
    expect(screen.queryByText(/встроить на сайт клиента/i)).toBeNull();
  });

  it("хранит состояние вкладки в URL", async () => {
    render(createElement(StartScreen, { initialTab: "chat", origin: "http://localhost:3000" }));

    fireEvent.click(screen.getByRole("tab", { name: "Админка" }));

    await waitFor(() => {
      expect(window.location.search).toBe("?tab=admin");
    });

    fireEvent.click(screen.getByRole("tab", { name: "MAX" }));

    await waitFor(() => {
      expect(window.location.search).toBe("?tab=max");
    });
  });

  it("даёт кнопку «открыть отдельно» на каждой вкладке", async () => {
    render(createElement(StartScreen, { initialTab: "chat", origin: "http://localhost:3000" }));

    const chatLink = screen.getByRole("link", { name: /открыть виджет отдельно/i });
    expect(chatLink.getAttribute("href")).toBe("/widget");
    expect(chatLink.getAttribute("target")).toBe("_blank");

    fireEvent.click(screen.getByRole("tab", { name: "MAX" }));
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /открыть ленту отдельно/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Админка" }));
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /открыть кабинет отдельно/i })).toBeTruthy();
    });
  });

  it("переключает вкладки стрелками, Enter и пробелом", async () => {
    render(createElement(StartScreen, { initialTab: "chat", origin: "http://localhost:3000" }));

    const chat = screen.getByRole("tab", { name: "Веб-чат" });
    const max = screen.getByRole("tab", { name: "MAX" });
    const admin = screen.getByRole("tab", { name: "Админка" });

    expect(chat.getAttribute("aria-selected")).toBe("true");
    expect(chat.getAttribute("tabindex")).toBe("0");
    expect(max.getAttribute("tabindex")).toBe("-1");

    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });

    await waitFor(() => {
      expect(max.getAttribute("aria-selected")).toBe("true");
    });
    expect(document.activeElement).toBe(max);

    fireEvent.keyDown(max, { key: "ArrowRight" });
    await waitFor(() => {
      expect(admin.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(admin, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(max.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(max, { key: "Enter" });
    await waitFor(() => {
      expect(max.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(max, { key: " " });
    await waitFor(() => {
      expect(max.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("показывает видимый фокус и доступные имена", async () => {
    const styles = await readFile(join(START_DIR, "styles.css"), "utf8");
    expect(styles).toMatch(/:focus-visible/);
    expect(styles).toMatch(/outline[^;]*var\(--sl-accent\)/);

    render(createElement(StartScreen, { initialTab: "chat", origin: "http://localhost:3000" }));

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBeTruthy();
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-selected")).toBeTruthy();
      expect(tab.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("не открывает экран без кода доступа и предлагает вход", async () => {
    checkAccessMock.mockResolvedValue({
      allowed: false,
      reason: "missing_code",
      retryAfterSeconds: null,
    });

    const page = await StartPage({ searchParams: Promise.resolve({}) });
    render(page);

    expect(screen.getByRole("heading", { name: /нужен код доступа/i })).toBeTruthy();
    const link = screen.getByRole("link", { name: /\/access/i });
    expect(link.getAttribute("href")).toBe("/access");
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("открывает нужную вкладку по параметру URL", async () => {
    const page = await StartPage({ searchParams: Promise.resolve({ tab: "max" }) });
    render(page);

    expect(screen.getByRole("tab", { name: "MAX" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("экран демо /start — живая лента MAX", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("показывает состояние загрузки, ошибки и пустоты", async () => {
    let resolvePending: ((value: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvePending = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(createElement(MaxFeed));

    expect(screen.getByText(/загружаем ленту/i)).toBeTruthy();

    await act(async () => {
      resolvePending?.(
        new Response(JSON.stringify({ messages: [], empty: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/пока сообщений нет/i)).toBeTruthy();
    });

    view.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("сеть недоступна");
      }),
    );
    render(createElement(MaxFeed));

    await waitFor(() => {
      expect(screen.getByText(/не удалось получить ленту/i)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /повторить/i })).toBeTruthy();
  });

  it("не опрашивает ленту, пока документ не виден", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [], empty: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(MaxFeed));

    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});

describe("маршрут GET /api/demo/max-feed", () => {
  let tenantId = "";

  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    process.env.ACCESS_CODE = ACCESS_CODE;
    process.env.SESSION_SECRET = SESSION_SECRET;
    await clearChannelState();
    tenantId = await resetTenant(TENANT_SLUG);
  });

  /**
   * Удаление строк состояния канала тестового арендатора.
   *
   * На `channel_state` стоит внешний ключ на арендатора, а общий помощник
   * очистки её не трогает: без этой очистки арендатор не удалится и тест
   * упадёт на посторонней ошибке.
   */
  async function clearChannelState(): Promise<void> {
    await ensureSchema();
    await testPool().query(
      "DELETE FROM channel_state WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = $1)",
      [TENANT_SLUG],
    );
  }

  afterAll(async () => {
    await closePool();
  });

  /** Подписанная cookie клиентского доступа. */
  async function accessCookie(): Promise<string> {
    const session = await verifyAccessCode(ACCESS_CODE);
    if (!session) throw new Error("Сессия доступа не создана");
    return buildAccessCookie(session).split(";")[0] as string;
  }

  async function seedMessages(): Promise<void> {
    const conversation = await testPool().query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel, external_chat_id, status)
       VALUES ($1, 'max', 'chat-1', 'open') RETURNING id`,
      [tenantId],
    );
    const conversationId = conversation.rows[0]?.id ?? "";
    await testPool().query(
      `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked, text_original, created_at)
       VALUES
         ($1, $2, gen_random_uuid(), 'client', '⟦ТЕЛЕФОН⟧', '+7 900 000-00-00', now() - interval '2 minutes'),
         ($1, $2, gen_random_uuid(), 'agent', 'Маскированный ответ', NULL, now() - interval '1 minute')`,
      [tenantId, conversationId],
    );
  }

  it("отдаёт сообщения канала max в порядке от свежих к старым", async () => {
    await seedMessages();

    const response = await maxFeedGet(
      new Request("http://localhost/api/demo/max-feed", {
        headers: { cookie: await accessCookie() },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as FeedResponse;

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("agent");
    expect(body.messages[1]?.role).toBe("client");
    expect(body.messages[0]?.text_masked).toBe("Маскированный ответ");
    expect(body.messages[0]?.created_at).toBeTruthy();
    expect(body.messages[0]?.conversation_id).toBeTruthy();
    expect(body.empty).toBe(false);
  });

  it("не отдаёт исходный текст и секреты", async () => {
    await seedMessages();

    const response = await maxFeedGet(
      new Request("http://localhost/api/demo/max-feed", {
        headers: { cookie: await accessCookie() },
      }),
    );
    const raw = await response.text();

    expect(raw).not.toContain("+7 900 000-00-00");
    expect(raw).not.toContain("text_original");
    expect(raw).not.toContain(ACCESS_CODE);
    expect(raw).not.toContain(SESSION_SECRET);
  });

  it("при пустой таблице отдаёт пустой массив, а не ошибку", async () => {
    const response = await maxFeedGet(
      new Request("http://localhost/api/demo/max-feed", {
        headers: { cookie: await accessCookie() },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as FeedResponse;
    expect(body.messages).toEqual([]);
    expect(body.empty).toBe(true);
  });

  it("без клиентского кода не отдаёт ленту", async () => {
    const response = await maxFeedGet(new Request("http://localhost/api/demo/max-feed"));

    expect(response.status).toBe(401);
  });

  it("отдаёт статус канала MAX из channel_state", async () => {
    await testPool().query(
      `INSERT INTO channel_state (tenant_id, channel, external_chat_id, marker, last_event_at)
       VALUES ($1, 'max', '', 4242, now())
       ON CONFLICT (tenant_id, channel, external_chat_id)
       DO UPDATE SET marker = EXCLUDED.marker, last_event_at = EXCLUDED.last_event_at`,
      [tenantId],
    );

    const response = await maxFeedGet(
      new Request("http://localhost/api/demo/max-feed", {
        headers: { cookie: await accessCookie() },
      }),
    );
    const body = (await response.json()) as FeedResponse;

    expect(body.status.worker_listening).toBe(true);
    expect(body.status.marker).toBe(4242);
    expect(body.status.last_event_at).toBeTruthy();
    expect(body.bot.username).toBe("se15151074_bot");
    expect(body.bot.link).toContain("max.ru");
  });
});
