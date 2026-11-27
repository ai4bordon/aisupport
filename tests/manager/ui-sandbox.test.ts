import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as historyGet } from "@/app/api/settings/history/route";
import { POST as sandboxPost } from "@/app/api/settings/sandbox/route";
import { SandboxClient } from "@/app/manager/sandbox/sandbox-client";
import { verifyManagerCode } from "@/modules/access";
import { buildManagerCookie } from "@/modules/access/session";
import { closePool } from "@/db/pool";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Тесты раздела кабинера менеджера «Песочница и история».
 *
 * Раздел состоит из двух частей: изолированный тестовый чат (вопрос →
 * ответ с оценкой, токенами и стоимостью) и история тестовых сессий с
 * возможностью повторить вопрос.
 *
 * Проверяются:
 * 1) бренд-раскладка — в файлах раздела нет сырых цветов, только токены;
 * 2) явные состояния: загрузка истории, ошибка истории, пустая история,
 *    ошибка тестового запроса (с текстом сервера, а не молчанием);
 * 3) пояснение об изоляции песочницы — ответ клиенту не отправляется,
 *    рабочее окружение не затрагивается;
 * 4) «Повторить» переносит вопрос из истории в поле песочницы;
 * 5) ответ показывает оценку, токены и стоимость.
 */

/** Корень репозитория ищется от файла теста вверх до папки с `package.json`. */
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

/** Арендатор и код менеджера тестового файла: свои значения на файл. */
const TENANT_SLUG = "test-manager-ui-sandbox";
const MANAGER_CODE = "test-manager-code-ui-sandbox";
const SESSION_SECRET = "test-manager-secret-ui-sandbox";

/**
 * Чистка таблиц среза настроек перед сбросом арендатора.
 *
 * Общий помощник `resetTenant` таблиц среза 08 не знает, а ссылки на
 * арендатора в них жёсткие: без чистки повторный прогон файла падал бы на
 * удалении арендатора. Помощник локальный: общий файл тестов не трогаем.
 */
async function clearSliceTables(slug: string): Promise<void> {
  await ensureSchema();
  const existing = await testPool().query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [slug],
  );
  const tenantId = existing.rows[0]?.id;
  if (!tenantId) {
    return;
  }
  await testPool().query("DELETE FROM agent_test_sessions WHERE tenant_id = $1", [
    tenantId,
  ]);
  await testPool().query("DELETE FROM agent_dialog_settings WHERE tenant_id = $1", [
    tenantId,
  ]);
  await testPool().query("DELETE FROM agent_settings WHERE tenant_id = $1", [
    tenantId,
  ]);
}

type SandboxSource = {
  kind: string;
  id: string;
  title: string;
  location: string | null;
};

type SandboxResponse = {
  session_id: string;
  settings_version: number;
  outcome: string;
  grade: string;
  answer: string;
  sources: SandboxSource[];
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  trace: Array<{
    node: string;
    latency_ms: number;
    tokens_in: number;
    tokens_out: number;
    cost_rub: number;
    detail: string | null;
  }>;
};

type HistorySession = {
  session_id: string;
  settings_version: number;
  settings_snapshot: { provider?: string; model?: string };
  request_text_masked: string;
  result: { outcome: string; answer: string; grade: string; sources: SandboxSource[] };
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  actor: string;
  created_at: string;
};

type HistoryPayload = { sessions: HistorySession[] };

const sandboxResponse: SandboxResponse = {
  session_id: "sandbox-session-1",
  settings_version: 3,
  outcome: "respond",
  grade: "ok",
  answer: "Ответ агента из песочницы",
  sources: [{ kind: "kb_article", id: "article-1", title: "Условия договора", location: null }],
  tokens_in: 120,
  tokens_out: 45,
  cost_rub: 1.25,
  trace: [
    {
      node: "respond",
      latency_ms: 40,
      tokens_in: 120,
      tokens_out: 45,
      cost_rub: 1.25,
      detail: "Модель: test-model",
    },
  ],
};

const historyPayload: HistoryPayload = {
  sessions: [
    {
      session_id: "sandbox-session-0",
      settings_version: 2,
      settings_snapshot: { provider: "test-provider", model: "test-model" },
      request_text_masked: "Какие условия по договору?",
      result: {
        outcome: "respond",
        answer: "Ответ прошлой сессии",
        grade: "invalid",
        sources: [],
      },
      tokens_in: 10,
      tokens_out: 20,
      cost_rub: 0.5,
      actor: "manager",
      created_at: "2026-11-27T10:00:00.000Z",
    },
  ],
};

type RouteStub = { status?: number; body?: unknown };

/**
 * Подмена `fetch`: GET отдаёт историю, POST — результат песочницы.
 *
 * Маршруты различаются по методу и адресу, поэтому тест может задать
 * отдельно ответ истории и ответ тестового запроса.
 */
function mockFetch(routes: { history?: RouteStub; sandbox?: RouteStub } = {}): void {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();
      const route =
        method === "POST" && url.includes("/api/settings/sandbox")
          ? routes.sandbox
          : routes.history;
      const status = route?.status ?? 200;
      const body = route?.body ?? (method === "POST" ? sandboxResponse : historyPayload);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
}

describe("бренд-разметка раздела песочницы", () => {
  it("использует только фирменные токены без сырых цветов", async () => {
    const files = [
      "src/app/manager/sandbox/page.tsx",
      "src/app/manager/sandbox/sandbox-client.tsx",
      "src/app/manager/sandbox/styles.css",
    ];
    const contents = await Promise.all(
      files.map((file) => readFile(resolve(REPO_ROOT, file), "utf8")),
    );
    const source = contents.join("\n");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).toContain("var(--sl-");
  });

  it("показывает видимый фокус клавиатурной навигации", async () => {
    const styles = await readFile(
      resolve(REPO_ROOT, "src/app/manager/sandbox/styles.css"),
      "utf8",
    );
    expect(styles).toContain(":focus-visible");
    expect(styles).toMatch(/outline:\s*(?!none)/);
  });
});

describe("состояния раздела песочницы", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("показывает состояние загрузки истории", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(createElement(SandboxClient));
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем историю тестов");
  });

  it("показывает состояние ошибки истории", async () => {
    mockFetch({ history: { status: 503, body: { error: { message: "База данных недоступна" } } } });
    render(createElement(SandboxClient));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить историю тестов");
  });

  it("показывает пустую историю тестов", async () => {
    mockFetch({ history: { body: { sessions: [] } } });
    render(createElement(SandboxClient));
    expect(await screen.findByText("История тестов пуста")).toBeInTheDocument();
  });

  it("поясняет, что песочница изолирована и клиенту ничего не отправляет", async () => {
    mockFetch();
    render(createElement(SandboxClient));
    const note = await screen.findByText(/не отправляется клиенту/i);
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent(/рабочее окружение/i);
  });

  it("показывает ответ с оценкой, токенами и стоимостью", async () => {
    mockFetch();
    render(createElement(SandboxClient));
    await screen.findByText("Ответ прошлой сессии");
    fireEvent.change(screen.getByLabelText("Вопрос для проверки"), {
      target: { value: "Какие условия по договору?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(await screen.findByText("Ответ агента из песочницы")).toBeInTheDocument();
    expect(screen.getByText(/Оценка: хорошо/)).toBeInTheDocument();
    expect(screen.getByText(/Токены: 120/)).toBeInTheDocument();
    expect(screen.getByText(/1,25 ₽/)).toBeInTheDocument();
  });

  it("показывает текст ошибки тестового запроса, а не молчит", async () => {
    mockFetch({
      sandbox: {
        status: 502,
        body: { error: { code: "upstream_error", message: "Провайдер модели недоступен" } },
      },
    });
    render(createElement(SandboxClient));
    await screen.findByText("Ответ прошлой сессии");
    fireEvent.change(screen.getByLabelText("Вопрос для проверки"), {
      target: { value: "Какие условия по договору?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(await screen.findByText("Провайдер модели недоступен")).toBeInTheDocument();
  });

  it("переносит вопрос из истории в поле песочницы по кнопке «Повторить»", async () => {
    mockFetch();
    render(createElement(SandboxClient));
    await screen.findByText("Ответ прошлой сессии");
    fireEvent.click(screen.getByRole("button", { name: /Повторить/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("Вопрос для проверки")).toHaveValue("Какие условия по договору?");
    });
  });

  it("переносит вопрос в поле песочницы и очищает прежнюю ошибку запроса", async () => {
    mockFetch({
      sandbox: {
        status: 502,
        body: { error: { code: "upstream_error", message: "Провайдер модели недоступен" } },
      },
    });
    render(createElement(SandboxClient));
    await screen.findByText("Ответ прошлой сессии");
    fireEvent.change(screen.getByLabelText("Вопрос для проверки"), {
      target: { value: "Какие условия по договору?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(await screen.findByText("Провайдер модели недоступен")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Повторить/ }));
    await waitFor(() => {
      expect(screen.queryByText("Провайдер модели недоступен")).toBeNull();
    });
  });
});

describe("маршруты данных песочницы", () => {
  let cookie = "";
  let tenantId = "";

  beforeAll(async () => {
    await ensureSchema();
    process.env.MANAGER_ACCESS_CODE = MANAGER_CODE;
    process.env.SESSION_SECRET = SESSION_SECRET;
    const session = await verifyManagerCode(MANAGER_CODE);
    if (!session) throw new Error("Не удалось создать сессию менеджера");
    cookie = buildManagerCookie(session).split(";")[0] ?? "";
    await clearSliceTables(TENANT_SLUG);
    tenantId = await resetTenant(TENANT_SLUG);
  });

  afterAll(async () => {
    await closePool();
  });

  it("не пускает историю без cookie менеджера", async () => {
    const response = await historyGet(new Request("http://localhost/api/settings/history"));
    expect(response.status).toBe(401);
  });

  it("не пускает тестовый запрос без cookie менеджера", async () => {
    const response = await sandboxPost(
      new Request("http://localhost/api/settings/sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Проверка" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("отдаёт пустую историю, когда тестовых сессий ещё не было", async () => {
    await testPool().query("DELETE FROM agent_test_sessions WHERE tenant_id = $1", [
      tenantId,
    ]);
    const response = await historyGet(
      new Request("http://localhost/api/settings/history", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as HistoryPayload;
    expect(body.sessions).toEqual([]);
  });

  it("отдаёт историю с версией конфигурации, моделью, оценкой, токенами и стоимостью", async () => {
    await testPool().query("DELETE FROM agent_test_sessions WHERE tenant_id = $1", [
      tenantId,
    ]);
    await testPool().query(
      `INSERT INTO agent_test_sessions (
         tenant_id, settings_version, settings_snapshot, request_text_masked,
         result, tokens_in, tokens_out, cost_rub, actor
       ) VALUES ($1, 7, '{"provider":"test-provider","model":"test-model"}'::jsonb,
         'Какие условия по договору?',
         '{"outcome":"respond","answer":"Ответ прошлой сессии","grade":"ok","sources":[]}'::jsonb,
         10, 20, 0.5, 'manager')`,
      [tenantId],
    );
    const response = await historyGet(
      new Request("http://localhost/api/settings/history", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as HistoryPayload;
    const session = body.sessions[0];
    expect(session?.session_id).toBeTruthy();
    expect(session?.settings_version).toBe(7);
    expect(session?.settings_snapshot?.model).toBe("test-model");
    expect(session?.result.grade).toBe("ok");
    expect(session?.tokens_in).toBe(10);
    expect(session?.tokens_out).toBe(20);
    expect(session?.cost_rub).toBe(0.5);
    expect(session?.created_at).toBeTruthy();
  });
});
