/**
 * Тесты раздела кабинета менеджера «Агент» (`src/app/manager/agent/**`).
 *
 * Раздел переносит готовую страницу настроек среза 08 в кабинет менеджера:
 * подключение к модели, системный промпт, параметры модели, недоступные
 * элементы управления, лимиты, песочница, история тестовых сессий и аудит
 * изменений.
 *
 * Проверяются требования владельца к UI-волне:
 * 1) бренд-разметка — в файлах раздела нет сырых цветов, только токены;
 * 2) честность состояния — нереализованные элементы управления собраны в
 *    один свёрнутый блок «В следующих версиях» с причиной у каждого, режим
 *    тени показан как состояние, а не как рабочий переключатель;
 * 3) явные состояния — загрузка, ошибка, пусто;
 * 4) работоспособность — настройка сохраняется, песочница запускается,
 *    история и аудит показываются;
 * 5) одна схема сохранения — общая кнопка «Сохранить» и явный признак
 *    несохранённых изменений, сообщение после сброса промпта;
 * 6) мобильная ширина 390 — горизонтального скролла нет, таблица истории
 *    прокручивается внутри ограниченного контейнера с явным признаком.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { AgentClient } from "@/app/manager/agent/agent-client";

/**
 * Отложенное разрешение прогона песочницы.
 *
 * `Promise.withResolvers` есть в Node 22, но библиотека типов проекта
 * объявлена как ES2023, поэтому конструктор приводится явно: обход типов
 * локальный и не трогает конфигурацию сборки.
 */
function deferredGate(): { promise: Promise<void>; release: () => void } {
  const constructor = Promise as unknown as {
    withResolvers: <T>() => {
      promise: Promise<T>;
      resolve: (value: T) => void;
    };
  };
  const { promise, resolve } = constructor.withResolvers<void>();
  return { promise, release: () => resolve() };
}

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
      throw new Error("Корень репозитория не найден выше tests/agent-settings");
    }
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot();
const AGENT_DIR = resolve(REPO_ROOT, "src/app/manager/agent");
const DEFAULT_PROMPT = "Ты — агент службы поддержки ПАО «Софтлайн».";

/** Реестр возможностей: тот же состав, что отдаёт модуль настроек. */
const CAPABILITIES = [
  { key: "provider", label: "Провайдер модели", supported: true, reason: null, control: "select" },
  { key: "model", label: "Модель", supported: true, reason: null, control: "text" },
  { key: "endpoint", label: "Адрес провайдера", supported: true, reason: null, control: "text" },
  { key: "system_prompt", label: "Системный промпт", supported: true, reason: null, control: "text" },
  { key: "temperature", label: "Температура ответа", supported: true, reason: null, control: "number" },
  { key: "max_tokens", label: "Лимит токенов ответа", supported: true, reason: null, control: "number" },
  { key: "shadow_mode", label: "Режим тени", supported: true, reason: null, control: "toggle" },
  {
    key: "tools",
    label: "Инструменты агента",
    supported: false,
    reason:
      "Отключение отдельного инструмента не реализовано: ядро вызывает поиск по БЗ, каталог и проверку полномочий всегда.",
    control: "toggle",
  },
  {
    key: "skills",
    label: "Навыки (markdown)",
    supported: false,
    reason: "Загрузка markdown-навыков не реализовано: в проекте нет загрузчика навыков.",
    control: "toggle",
  },
  {
    key: "mcp",
    label: "MCP-подключения к внешним серверам",
    supported: false,
    reason:
      "MCP-подключения к внешним серверам (Streamable HTTP, SSE, stdio) не реализовано: в проекте нет MCP-клиента.",
    control: "toggle",
  },
  {
    key: "limits",
    label: "Лимиты и бюджет",
    supported: false,
    reason:
      "Изменение лимитов из кабинета не реализовано: лимиты задаются переменными окружения и общим модулем src/modules/limits.",
    control: "number",
  },
  {
    key: "top_p",
    label: "Top-p",
    supported: false,
    reason: "Параметр top_p не реализовано: клиент модели его не передаёт провайдеру.",
    control: "number",
  },
  {
    key: "seed",
    label: "Seed",
    supported: false,
    reason: "Параметр seed не реализовано: клиент модели его не передаёт провайдеру.",
    control: "number",
  },
  {
    key: "promises.schedule",
    label: "Отложенные обещания (email, CRM)",
    supported: false,
    reason: "Отправка в email и CRM не реализовано: интеграций с почтой и CRM в проекте нет.",
    control: "toggle",
  },
] as const;

type Capability = (typeof CAPABILITIES)[number];

const SETTINGS_PAYLOAD = {
  version: 3,
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  endpoint: "https://opencode.ai/inference/go/v1",
  system_prompt: DEFAULT_PROMPT,
  temperature: 0.2,
  max_tokens: 1024,
  shadow_mode: true,
  created_at: "2026-11-28T08:00:00.000Z",
  capabilities: CAPABILITIES,
};

const HISTORY_PAYLOAD = {
  sessions: [
    {
      session_id: "session-1",
      settings_version: 3,
      settings_snapshot: { model: "deepseek-v4.1-flash", temperature: 0.2 },
      request_text_masked: "Какие условия лицензирования?",
      result: {
        outcome: "respond",
        answer: "Условия лицензирования описаны в договоре.",
        grade: "ok",
        sources: [{ kind: "kb_article", id: "article-1", title: "Условия" }],
      },
      tokens_in: 120,
      tokens_out: 45,
      cost_rub: "1.2500",
      actor: "manager",
      created_at: "2026-11-28T09:00:00.000Z",
    },
  ],
};

const AUDIT_PAYLOAD = {
  entries: [
    {
      id: "audit-1",
      actor: "manager",
      action: "update",
      entity: "agent_settings",
      key: "model",
      before: { model: "deepseek-v4.1-flash" },
      after: { model: "deepseek-v4-pro" },
      created_at: "2026-11-28T09:30:00.000Z",
    },
  ],
};

const SANDBOX_PAYLOAD = {
  session_id: "session-2",
  settings_version: 3,
  outcome: "respond",
  grade: "ok",
  answer: "Ответ песочницы.",
  sources: [],
  tokens_in: 10,
  tokens_out: 20,
  cost_rub: "0.5000",
  trace: [],
};

type ApiOptions = {
  settings?: unknown;
  history?: unknown;
  audit?: unknown;
  sandbox?: unknown;
  /** Ответы, которые должны упасть с ошибкой. */
  fail?: { settings?: number; history?: number; audit?: number; sandbox?: number };
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Ответ подставного `fetch`: адрес и тело запроса. */
type FetchCall = [input: unknown, init?: RequestInit];

/**
 * Подставной ответ API кабинета.
 *
 * Ответ разбирается по адресу и методу: раздел ходит в `/api/settings`,
 * `/api/settings/history`, `/api/settings/sandbox` и `/audit`.
 */
function mockApi(options: ApiOptions = {}): Mock<(input: unknown, init?: RequestInit) => Promise<Response>> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.startsWith("/api/settings/sandbox")) {
      if (options.fail?.sandbox) {
        return jsonResponse({ error: { message: "Песочница недоступна" } }, options.fail.sandbox);
      }
      return jsonResponse(options.sandbox ?? SANDBOX_PAYLOAD);
    }
    if (url.startsWith("/api/settings/history")) {
      if (options.fail?.history) {
        return jsonResponse({ error: { message: "История недоступна" } }, options.fail.history);
      }
      return jsonResponse(options.history ?? HISTORY_PAYLOAD);
    }
    if (url.startsWith("/api/settings")) {
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key?: string; value?: unknown };
        return jsonResponse({
          version: 4,
          provider: SETTINGS_PAYLOAD.provider,
          model: SETTINGS_PAYLOAD.model,
          endpoint: SETTINGS_PAYLOAD.endpoint,
          system_prompt: SETTINGS_PAYLOAD.system_prompt,
          temperature: SETTINGS_PAYLOAD.temperature,
          max_tokens: SETTINGS_PAYLOAD.max_tokens,
          created_at: SETTINGS_PAYLOAD.created_at,
          saved_key: body.key ?? null,
          saved_value: body.value ?? null,
        });
      }
      if (options.fail?.settings) {
        return jsonResponse({ error: { message: "Настройки недоступны" } }, options.fail.settings);
      }
      return jsonResponse(options.settings ?? SETTINGS_PAYLOAD);
    }
    if (url.startsWith("/audit")) {
      if (options.fail?.audit) {
        return jsonResponse({ error: { message: "Аудит недоступен" } }, options.fail.audit);
      }
      return jsonResponse(options.audit ?? AUDIT_PAYLOAD);
    }
    return jsonResponse({ error: { message: "Неизвестный маршрут" } }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAgent(): void {
  render(createElement(AgentClient, { defaultPrompt: DEFAULT_PROMPT }));
}

/** Запросы `PUT /api/settings`, сделанные тестом. */
function putCalls(
  fetchMock: Mock<(input: unknown, init?: RequestInit) => Promise<Response>>,
): FetchCall[] {
  return fetchMock.mock.calls.filter(
    (call) =>
      String(call[0]) === "/api/settings" &&
      (call[1]?.method ?? "GET").toUpperCase() === "PUT",
  ) as unknown as FetchCall[];
}

describe("бренд-разметка раздела «Агент»", () => {
  it("в файлах раздела нет сырых цветов", () => {
    const files = [
      "src/app/manager/agent/page.tsx",
      "src/app/manager/agent/agent-client.tsx",
      "src/app/manager/agent/styles.css",
    ];
    const source = files
      .map((file) => readFileSync(resolve(REPO_ROOT, file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
    expect(source).toContain("var(--sl-");
  });

  it("показывает видимый фокус клавиатурной навигации", () => {
    const styles = readFileSync(resolve(AGENT_DIR, "styles.css"), "utf8");

    expect(styles).toContain(":focus-visible");
    expect(styles).toMatch(/outline:[^;]*var\(--sl-accent\)/);
    expect(styles).not.toMatch(/outline:\s*none/);
  });
});

describe("состояния раздела «Агент»", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("показывает состояние загрузки", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    renderAgent();

    expect(screen.getByRole("status")).toHaveTextContent("Загружаем настройки агента");
  });

  it("показывает состояние ошибки, когда настройки не пришли", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Сеть недоступна")));

    renderAgent();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить настройки агента");
  });

  it("показывает пустую историю и пустой аудит", async () => {
    mockApi({ history: { sessions: [] }, audit: { entries: [] } });

    renderAgent();

    expect(await screen.findByText("Тестовых сессий пока нет")).toBeInTheDocument();
    expect(await screen.findByText("Изменений пока не было")).toBeInTheDocument();
  });

  it("показывает ошибку истории отдельно от ошибки настроек", async () => {
    mockApi({ fail: { history: 503 } });

    renderAgent();

    const section = await screen.findByRole("region", { name: "История тестовых сессий" });
    expect(await within(section).findByRole("alert")).toHaveTextContent(
      "Не удалось загрузить историю тестовых сессий",
    );
  });
});

describe("форма настроек агента", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("показывает поддерживаемые настройки из реестра возможностей", async () => {
    mockApi();

    renderAgent();

    expect(await screen.findByLabelText("Модель")).toHaveValue("deepseek-v4.1-flash");
    expect(screen.getByLabelText("Адрес провайдера")).toHaveValue(
      "https://opencode.ai/inference/go/v1",
    );
    expect(screen.getByLabelText("Текст системного промпта")).toHaveValue(DEFAULT_PROMPT);
    expect(screen.getByLabelText("Температура ответа")).toHaveValue(0.2);
    expect(screen.getByLabelText("Лимит токенов ответа")).toHaveValue(1024);
  });

  it("собирает недоступные элементы в один свёрнутый блок «В следующих версиях»", async () => {
    mockApi();

    renderAgent();

    await screen.findByLabelText("Модель");

    const section = screen.getByRole("region", { name: "В следующих версиях" });
    const details = within(section).getByRole("group");
    expect(details.tagName).toBe("DETAILS");
    // Свёрнутый блок: содержимое не раскрыто по умолчанию.
    expect(details.hasAttribute("open")).toBe(false);
    expect(
      within(section).getByText(/Показать недоступные элементы \(\d+\)/),
    ).toBeInTheDocument();

    // Отдельных полей на весь экран нет: у недоступного элемента нет
    // ни поля ввода, ни своей карточки.
    for (const capability of CAPABILITIES.filter((item) => !item.supported)) {
      expect(
        section.querySelector(`[data-capability="${capability.key}"]`),
        `есть отдельное поле ${capability.key}`,
      ).toBeNull();
      expect(
        section.querySelector(`[data-capability-item="${capability.key}"]`),
        `нет записи ${capability.key} в блоке`,
      ).not.toBeNull();
    }
  });

  it("показывает причину недоступности у каждого элемента блока", async () => {
    mockApi();

    renderAgent();

    await screen.findByLabelText("Модель");

    const section = screen.getByRole("region", { name: "В следующих версиях" });
    for (const capability of CAPABILITIES.filter((item) => !item.supported)) {
      const item = section.querySelector(
        `[data-capability-item="${capability.key}"]`,
      );
      expect(item, `нет записи ${capability.key}`).not.toBeNull();
      expect(item?.textContent ?? "").toContain(capability.label);
      expect(item?.textContent ?? "").toContain(capability.reason as string);
      expect(item?.textContent ?? "").toContain("не реализовано");
    }
    expect(within(section).getAllByText("не реализовано").length).toBe(
      CAPABILITIES.filter((item) => !item.supported).length,
    );
  });

  it("показывает режим тени как состояние, а не как рабочий переключатель", async () => {
    mockApi();

    renderAgent();

    const toggle = (await screen.findByLabelText("Режим тени")) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(screen.getByText("включён")).toBeInTheDocument();
  });
});

describe("единая схема сохранения настроек", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("использует одну кнопку «Сохранить» на весь раздел", async () => {
    mockApi();

    renderAgent();

    await screen.findByLabelText("Модель");

    const saveButtons = screen.getAllByRole("button", { name: "Сохранить" });
    expect(saveButtons).toHaveLength(1);
    // У полей своих кнопок сохранения нет.
    expect(
      screen.queryByRole("button", { name: /Сохранить: / }),
    ).toBeNull();
  });

  it("показывает признак несохранённых изменений и включает кнопку", async () => {
    mockApi();

    renderAgent();

    const model = (await screen.findByLabelText("Модель")) as HTMLInputElement;
    expect(screen.getByText("Все изменения сохранены")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();

    fireEvent.change(model, { target: { value: "deepseek-v4-pro" } });

    expect(screen.getByText("Есть несохранённые изменения")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить" })).not.toBeDisabled();
  });

  it("сохраняет изменённые настройки общей кнопкой и подтверждает результат", async () => {
    const fetchMock = mockApi();

    renderAgent();

    const model = (await screen.findByLabelText("Модель")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "deepseek-v4-pro" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(putCalls(fetchMock)).toHaveLength(1);
    });
    const [url, init] = putCalls(fetchMock)[0] as FetchCall;
    expect(url).toBe("/api/settings");
    const body = JSON.parse(String(init?.body ?? "{}")) as { key?: string; value?: unknown };
    expect(body.key).toBe("model");
    expect(body.value).toBe("deepseek-v4-pro");
    expect(await screen.findByText("Настройки сохранены")).toBeInTheDocument();
    // После сохранения признак несохранённых изменений снимается.
    expect(screen.getByText("Все изменения сохранены")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  });

  it("сохраняет все изменённые поля по очереди одной кнопкой", async () => {
    const fetchMock = mockApi();

    renderAgent();

    const model = (await screen.findByLabelText("Модель")) as HTMLInputElement;
    const temperature = screen.getByLabelText(
      "Температура ответа",
    ) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "deepseek-v4-pro" } });
    fireEvent.change(temperature, { target: { value: "0.7" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(putCalls(fetchMock)).toHaveLength(2);
    });
    const saved = putCalls(fetchMock).map(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        key?: string;
        value?: unknown;
      };
      return [body.key, body.value];
    });
    expect(saved).toEqual(
      expect.arrayContaining([
        ["model", "deepseek-v4-pro"],
        ["temperature", 0.7],
      ]),
    );
    expect(await screen.findByText("Настройки сохранены")).toBeInTheDocument();
  });

  it("показывает ошибку сервера при отказе сохранить настройку", async () => {
    mockApi();
    const fetchMock = mockApi();
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings" && (init?.method ?? "GET").toUpperCase() === "PUT") {
        return jsonResponse(
          { error: { message: "Настройка «model» недоступна" } },
          422,
        );
      }
      return jsonResponse(SETTINGS_PAYLOAD);
    });

    renderAgent();

    const model = (await screen.findByLabelText("Модель")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "deepseek-v4-pro" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Настройка «model» недоступна")).toBeInTheDocument();
    // Несохранённое изменение осталось несохранённым.
    expect(screen.getByText("Есть несохранённые изменения")).toBeInTheDocument();
  });

  it("после сброса промпта сообщает, что изменения надо сохранить", async () => {
    const fetchMock = mockApi({
      settings: { ...SETTINGS_PAYLOAD, system_prompt: "сохранённый промпт" },
    });

    renderAgent();

    const prompt = (await screen.findByLabelText("Текст системного промпта")) as HTMLTextAreaElement;
    expect(prompt).toHaveValue("сохранённый промпт");
    fireEvent.click(screen.getByRole("button", { name: "Сбросить к стандартному" }));

    expect(prompt).toHaveValue(DEFAULT_PROMPT);
    expect(
      screen.getByText("Промпт сброшен к стандартному — сохраните, чтобы применить"),
    ).toBeInTheDocument();
    // Сброс только ставит значение в форму: запроса на сохранение нет.
    expect(putCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText("Есть несохранённые изменения")).toBeInTheDocument();
  });

  it("сброс промпта, совпадающего со стандартным, не выдумывает изменение", async () => {
    const fetchMock = mockApi();

    renderAgent();

    const prompt = (await screen.findByLabelText("Текст системного промпта")) as HTMLTextAreaElement;
    expect(prompt).toHaveValue(DEFAULT_PROMPT);
    fireEvent.click(screen.getByRole("button", { name: "Сбросить к стандартному" }));

    expect(
      screen.getByText("Промпт уже стандартный — сохранять нечего"),
    ).toBeInTheDocument();
    expect(putCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText("Все изменения сохранены")).toBeInTheDocument();
  });
});

describe("песочница, история и аудит", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("запускает вопрос в песочнице и показывает результат", async () => {
    const fetchMock = mockApi();

    renderAgent();

    const question = (await screen.findByLabelText("Вопрос для проверки")) as HTMLTextAreaElement;
    fireEvent.change(question, { target: { value: "Какие условия лицензирования?" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить в песочнице" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/sandbox",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const [, init] = fetchMock.mock.calls.find(
      (call) => String(call[0]) === "/api/settings/sandbox",
    ) as unknown as FetchCall;
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    expect(body.text).toBe("Какие условия лицензирования?");
    expect(await screen.findByText("Ответ песочницы.")).toBeInTheDocument();
  });

  it("показывает текст ожидания во время прогона песочницы", async () => {
    mockApi();
    const gate = deferredGate();
    const fetchMock = mockApi();
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith("/api/settings/sandbox")) {
        await gate.promise;
        return jsonResponse(SANDBOX_PAYLOAD);
      }
      return jsonResponse(SETTINGS_PAYLOAD);
    });

    renderAgent();

    const question = (await screen.findByLabelText("Вопрос для проверки")) as HTMLTextAreaElement;
    fireEvent.change(question, { target: { value: "Какие условия лицензирования?" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить в песочнице" }));

    // Во время прогона виден текст ожидания, а не только заблокированная
    // кнопка.
    expect(
      await screen.findByText(/Запрос отправлен в песочницу — ждём ответ агента/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Запускаем…" }),
    ).toBeDisabled();

    gate.release();
    expect(await screen.findByText("Ответ песочницы.")).toBeInTheDocument();
    expect(
      screen.queryByText(/Запрос отправлен в песочницу/),
    ).toBeNull();
  });

  it("не запускает песочницу с пустым вопросом", async () => {
    const fetchMock = mockApi();

    renderAgent();

    await screen.findByLabelText("Вопрос для проверки");
    fireEvent.click(screen.getByRole("button", { name: "Запустить в песочнице" }));

    expect(await screen.findByText("Вопрос для проверки не задан")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]) === "/api/settings/sandbox"),
    ).toBe(false);
  });

  it("показывает историю тестовых сессий с версией, оценкой и затратами", async () => {
    mockApi();

    renderAgent();

    const section = await screen.findByRole("region", { name: "История тестовых сессий" });
    expect(within(section).getByText("3")).toBeInTheDocument();
    expect(within(section).getByText("подтверждён")).toBeInTheDocument();
    expect(within(section).getByText("120 / 45")).toBeInTheDocument();
    expect(within(section).getByText("1,25 ₽")).toBeInTheDocument();
    expect(within(section).getByText("deepseek-v4.1-flash")).toBeInTheDocument();
  });

  it("показывает аудит изменений: кто, что, до и после", async () => {
    mockApi();

    renderAgent();

    const section = await screen.findByRole("region", { name: "Аудит изменений" });
    expect(within(section).getByText("manager")).toBeInTheDocument();
    expect(within(section).getByText("model")).toBeInTheDocument();
    expect(within(section).getByText(/deepseek-v4-pro/)).toBeInTheDocument();
  });

  it("повторяет вопрос из истории в песочнице", async () => {
    mockApi();

    renderAgent();

    const section = await screen.findByRole("region", { name: "История тестовых сессий" });
    fireEvent.click(
      within(section).getByRole("button", { name: /повторить тестовую сессию/i }),
    );

    expect(await screen.findByLabelText("Вопрос для проверки")).toHaveValue(
      "Какие условия лицензирования?",
    );
  });
});

describe("мобильная ширина раздела «Агент»", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("таблицу истории показывает в ограниченном прокручиваемом контейнере", async () => {
    mockApi();

    renderAgent();

    const section = await screen.findByRole("region", { name: "История тестовых сессий" });
    const scroll = within(section).getByRole("region", {
      name: "Прокручиваемая таблица истории тестовых сессий",
    });
    expect(scroll.className).toContain("sl-agent-table-scroll");
    expect(scroll.querySelector("table")).not.toBeNull();
    // Явный признак горизонтальной прокрутки виден менеджеру.
    expect(
      within(section).getByText(/Таблицу можно прокручивать вбок/),
    ).toBeInTheDocument();
  });

  it("в стилях раздела нет фиксированной ширины и есть правила для узкого экрана", () => {
    const styles = readFileSync(resolve(AGENT_DIR, "styles.css"), "utf8");

    expect(styles).not.toMatch(/min-width:\s*\d+px/);
    expect(styles).toMatch(/overflow-x:\s*auto/);
    expect(styles).toMatch(/@media \(max-width: 640px\)/);
    expect(styles).toMatch(/box-sizing:\s*border-box/);
  });
});
