import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/manager/queue/route";
import { QueueClient } from "@/app/manager/queue/queue-client";
import { verifyAccessCode } from "@/modules/access";
import { buildAccessCookie } from "@/modules/access/session";
import { closePool } from "@/db/pool";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

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
const TENANT_SLUG = "test-manager-ui-queue";
const MANAGER_CODE = "test-manager-code-ui-queue";
const SESSION_SECRET = "test-manager-secret-ui-queue";

type QueuePayload = {
  items: Array<{
    id: string;
    conversation_id: string;
    reason: string;
    summary: string;
    /** Вопрос клиента: тема обращения. */
    question: string | null;
    draft: string | null;
    sources: unknown[];
    status: string;
    sla_due_at: string | null;
    overdue: boolean;
    created_at: string;
    channel: string;
    result: string;
    trace_ref: string;
    is_shadow: boolean;
    steps: Array<{
      node: string;
      endpoint: string | null;
      tokens_in: number;
      tokens_out: number;
      cost_rub: string;
      latency_ms: number;
      created_at: string;
    }>;
    promises: Array<{
      id: string;
      text: string;
      due_at: string;
      owner: string;
      status: string;
      conversation_id: string;
    }>;
  }>;
  promises: Array<{
    id: string;
    conversation_id: string;
    text: string;
    due_at: string;
    owner: string;
    status: string;
  }>;
};

const samplePayload: QueuePayload = {
  items: [
    {
      id: "a1b2c3d4-1111-4111-8111-111111111111",
      conversation_id: "conversation-1",
      reason: "нет подтверждённого источника",
      summary: "Клиент просит подтвердить условия",
      question: "Как настроить списание лицензий",
      draft: "Черновик ответа",
      sources: [{ kind: "kb_article", id: "article-1", title: "Условия" }],
      status: "open",
      sla_due_at: null,
      overdue: false,
      created_at: "2026-11-27T10:00:00.000Z",
      channel: "web",
      result: "Черновик ответа",
      trace_ref: "conversation-1",
      is_shadow: false,
      steps: [
        {
          node: "retrieve",
          endpoint: "GET /kb/search",
          tokens_in: 10,
          tokens_out: 20,
          cost_rub: "1.2500",
          latency_ms: 30,
          created_at: "2026-11-27T10:00:00.000Z",
        },
      ],
      promises: [
        {
          id: "promise-1",
          text: "Подготовить ответ",
          due_at: "2026-11-28T10:00:00.000Z",
          owner: "Менеджер",
          status: "open",
          conversation_id: "conversation-1",
        },
      ],
    },
  ],
  promises: [
    {
      id: "promise-1",
      conversation_id: "conversation-1",
      text: "Подготовить ответ",
      due_at: "2026-11-28T10:00:00.000Z",
      owner: "Менеджер",
      status: "open",
    },
  ],
};

function mockQueueResponse(payload: QueuePayload = samplePayload): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

async function managerCookie(): Promise<string> {
  // Код один на весь стенд: кабинет открывается той же cookie, что и чат
  // (решение владельца от 28.11.2026).
  process.env.ACCESS_CODE = MANAGER_CODE;
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = await verifyAccessCode(MANAGER_CODE);
  if (!session) throw new Error("Не удалось создать сессию доступа");
  return buildAccessCookie(session).split(";")[0] ?? "";
}

async function seedQueueData(): Promise<{
  tenantId: string;
  oldConversation: string;
  newConversation: string;
  otherTenant: string;
}> {
  const tenantId = await resetTenant(TENANT_SLUG);
  const conversations = await testPool().query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, status)
     VALUES ($1, 'web', 'escalate'), ($1, 'max', 'escalate')
     RETURNING id`,
    [tenantId],
  );
  const otherTenant = await testPool().query<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [`${TENANT_SLUG}-other`, "Другой арендатор"],
  );
  const otherConversation = await testPool().query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, status)
     VALUES ($1, 'web', 'escalate') RETURNING id`,
    [otherTenant.rows[0]?.id],
  );
  await testPool().query("DELETE FROM escalations WHERE tenant_id = $1", [
    otherTenant.rows[0]?.id,
  ]);
  const oldConversation = conversations.rows[0]?.id ?? "";
  const newConversation = conversations.rows[1]?.id ?? "";
  const hasStepKey = await testPool().query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'agent_steps' AND column_name = 'step_key'
     ) AS present`,
  );
  const stepInsert = hasStepKey.rows[0]?.present
    ? `INSERT INTO agent_steps (
         tenant_id, conversation_id, node, endpoint, tokens_in, tokens_out,
         cost_rub, latency_ms, step_key
       ) VALUES ($1, $2, 'retrieve', 'GET /kb/search', 10, 20, 1.25, 30, 'retrieve:1')`
    : `INSERT INTO agent_steps (
         tenant_id, conversation_id, node, endpoint, tokens_in, tokens_out,
         cost_rub, latency_ms
       ) VALUES ($1, $2, 'retrieve', 'GET /kb/search', 10, 20, 1.25, 30)`;
  await testPool().query(stepInsert, [tenantId, newConversation]);
  await testPool().query(
    `INSERT INTO escalations (
       tenant_id, conversation_id, reason, summary, draft, sources, status,
       sla_due_at, created_at, channel, result, trace_ref, is_shadow
     ) VALUES
       ($1, $2, 'нужен менеджер', 'Старое обращение', 'Черновик', '[]'::jsonb,
        'open', NULL, '2026-11-26T09:00:00.000Z', 'web', 'Старое обращение', $2, false),
       ($1, $3, 'нужен менеджер', 'Новое обращение', 'Черновик',
        '[{"kind":"kb_article","id":"article-1"}]'::jsonb, 'open', NULL,
        '2026-11-27T10:00:00.000Z', 'web', 'Новое обращение', $3, false),
       ($4, $5, 'чужое обращение', 'Чужое обращение', NULL, '[]'::jsonb,
        'open', NULL, '2026-11-27T11:00:00.000Z', 'web', 'Чужое обращение', $5, false)`,
    [tenantId, oldConversation, newConversation, otherTenant.rows[0]?.id, otherConversation.rows[0]?.id],
  );
  await testPool().query(
    `INSERT INTO promises (
       tenant_id, conversation_id, text, due_at, owner, status, created_at
     ) VALUES ($1, $2, 'Подготовить счёт', '2026-11-28T10:00:00.000Z',
       'Менеджер', 'open', '2026-11-27T10:00:00.000Z')`,
    [tenantId, newConversation],
  );
  return { tenantId, oldConversation, newConversation, otherTenant: otherTenant.rows[0]?.id ?? "" };
}

describe("бренд-разметка раздела очереди", () => {
  it("использует только фирменные токены без сырых цветов", async () => {
    const files = [
      "src/app/manager/queue/page.tsx",
      "src/app/manager/queue/queue-client.tsx",
      "src/app/manager/queue/promises.tsx",
      "src/app/manager/queue/styles.css",
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
      resolve(REPO_ROOT, "src/app/manager/queue/styles.css"),
      "utf8",
    );
    expect(styles).toContain(":focus-visible");
    expect(styles).toMatch(/outline:\s*(?!none)/);
  });
});

describe("состояния раздела очереди", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("показывает состояние загрузки", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(createElement(QueueClient));
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем очередь");
  });

  it("показывает состояние ошибки", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Сеть недоступна")));
    render(createElement(QueueClient));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить очередь");
  });

  it("показывает пустую очередь и пустой журнал обещаний", async () => {
    mockQueueResponse({ items: [], promises: [] });
    render(createElement(QueueClient));
    expect(await screen.findByText("Очередь пуста")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Журнал обещаний/ }));
    expect(screen.getByText("Журнал обещаний пуст")).toBeInTheDocument();
  });

  it("использует семантическую разметку и доступные имена", async () => {
    mockQueueResponse();
    render(createElement(QueueClient));
    expect(await screen.findByRole("main", { name: "Очередь обращений" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Обращения в очереди" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Клиент просит подтвердить условия/ })).toBeInTheDocument();
  });

  it("переключает вкладки клавиатурой", async () => {
    mockQueueResponse();
    render(createElement(QueueClient));
    const queueTab = await screen.findByRole("tab", { name: /Очередь/ });
    queueTab.focus();
    fireEvent.keyDown(queueTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Журнал обещаний/ })).toHaveFocus();
  });

  it("показывает трассу, стоимость, обещания и источники раскрытого обращения", async () => {
    mockQueueResponse();
    render(createElement(QueueClient));
    fireEvent.click(await screen.findByRole("button", { name: /Клиент просит подтвердить условия/ }));
    expect(screen.getByText("Что сделала программа")).toBeInTheDocument();
    expect(screen.getByText("1,25 ₽")).toBeInTheDocument();
    expect(screen.getByText("Подготовить ответ")).toBeInTheDocument();
    expect(screen.getByText("Условия")).toBeInTheDocument();
  });

  it("показывает просроченное обращение отдельной подписью", async () => {
    const payload = structuredClone(samplePayload);
    payload.items[0]!.overdue = true;
    mockQueueResponse(payload);
    render(createElement(QueueClient));
    expect(await screen.findAllByText(/Просрочено/)).not.toHaveLength(0);
  });

  it("показывает тему обращения, номер и канал", async () => {
    // Регрессия живьёма (UX-аудит 28.11): карточки очереди были
    // неразличимы — у всех одна и та же сводка, ни номера, ни вопроса
    // клиента. Найти нужное обращение было невозможно.
    mockQueueResponse();
    render(createElement(QueueClient));

    const item = await screen.findByRole("button", { name: /Открыть обращение/ });
    // Вопрос клиента — тема обращения.
    expect(item).toHaveTextContent("Как настроить списание лицензий");
    // Короткий номер обращения: первые символы идентификатора.
    expect(item).toHaveTextContent("a1b2c3d4");
    // Канал.
    expect(item).toHaveTextContent("Веб");
  });

  it("ищет обращение по вопросу клиента", async () => {
    // Регрессия живьёма (UX-аудит 28.11): в очереди 27 обращений с
    // одинаковой сводкой, и найти нужное без поиска было невозможно.
    const payload = structuredClone(samplePayload);
    payload.items.push({
      ...structuredClone(samplePayload.items[0]!),
      id: "b2c3d4e5-2222-4222-8222-222222222222",
      question: "Как подключить лицензирование к порталу",
      summary: "Клиент просит подтвердить условия",
      status: "closed",
      channel: "max",
    });
    mockQueueResponse(payload);
    render(createElement(QueueClient));

    const search = await screen.findByLabelText("Поиск по обращениям");
    await act(async () => {
      fireEvent.change(search, { target: { value: "подключить лицензирование" } });
    });

    await waitFor(() => {
      const items = screen.getAllByRole("button", { name: /Открыть обращение/ });
      expect(items).toHaveLength(1);
    });
    expect(
      screen.getByText("Как подключить лицензирование к порталу"),
    ).toBeInTheDocument();
  });

  it("фильтрует обращения по статусу и каналу", async () => {
    const payload = structuredClone(samplePayload);
    payload.items.push({
      ...structuredClone(samplePayload.items[0]!),
      id: "b2c3d4e5-2222-4222-8222-222222222222",
      question: "Другое обращение",
      status: "closed",
      channel: "max",
    });
    mockQueueResponse(payload);
    render(createElement(QueueClient));

    const status = await screen.findByLabelText("Фильтр по статусу");
    await act(async () => {
      fireEvent.change(status, { target: { value: "closed" } });
    });
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Открыть обращение/ })).toHaveLength(1);
    });

    const channel = screen.getByLabelText("Фильтр по каналу");
    await act(async () => {
      fireEvent.change(channel, { target: { value: "web" } });
    });
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: /Открыть обращение/ })).toHaveLength(0);
    });
  });

  it("не показывает незавершённые действия", async () => {
    mockQueueResponse();
    render(createElement(QueueClient));
    fireEvent.click(await screen.findByRole("button", { name: /Клиент просит подтвердить условия/ }));

    // Незавершённых действий на демо нет: пять неактивных кнопок
    // «в разработке» выглядели бы как недоделка и ничего не делали.
    for (const name of [
      "Сохранить черновик",
      "Отправить клиенту",
      "Вернуть агенту",
      "Отложить",
      "Написать статью",
    ]) {
      expect(
        screen.queryByRole("button", { name: new RegExp(name) }),
      ).toBeNull();
    }
    expect(screen.queryByText(/в разработке/)).toBeNull();

    // «Запомнить ответ» реализован: действие менеджера само является
    // одобрением, и ответ попадает в базу знаний (R7, ADR-0019).
    const remember = screen.getByRole("button", { name: /Запомнить ответ/ });
    expect(remember).not.toBeDisabled();
    expect(remember).toHaveTextContent("Запомнить ответ");
  });
});

describe("маршрут данных очереди", () => {
  let tenantId = "";
  let oldConversation = "";
  let newConversation = "";
  let otherTenant = "";
  let cookie = "";

  beforeAll(async () => {
    await ensureSchema();
    cookie = await managerCookie();
  });

  beforeEach(async () => {
    const seeded = await seedQueueData();
    tenantId = seeded.tenantId;
    oldConversation = seeded.oldConversation;
    newConversation = seeded.newConversation;
    otherTenant = seeded.otherTenant;
  });

  afterAll(async () => {
    await closePool();
  });

  it("не пускает запрос без cookie менеджера", async () => {
    const response = await GET(new Request("http://localhost/api/manager/queue"));
    expect(response.status).toBe(401);
  });

  it("отдаёт записи по времени и отделяет данные другого арендатора", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/queue", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as QueuePayload;
    expect(body.items.map((item) => item.conversation_id)).toEqual([
      newConversation,
      oldConversation,
    ]);
    expect(body.items.some((item) => item.summary === "Чужое обращение")).toBe(false);
  });

  it("отдаёт шаги трассы, стоимость и обещания по диалогу", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/queue", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as QueuePayload;
    const item = body.items.find((entry) => entry.conversation_id === newConversation);
    expect(item?.steps).toHaveLength(1);
    expect(item?.steps[0]?.node).toBe("retrieve");
    expect(item?.promises[0]?.text).toBe("Подготовить счёт");
  });

  it("возвращает пустые массивы для пустой таблицы", async () => {
    await testPool().query("DELETE FROM escalations WHERE tenant_id = $1", [tenantId]);
    await testPool().query("DELETE FROM promises WHERE tenant_id = $1", [tenantId]);
    const response = await GET(
      new Request("http://localhost/api/manager/queue", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as QueuePayload;
    expect(body.items).toEqual([]);
    expect(body.promises).toEqual([]);
  });

  it("определяет арендатора на сервере и игнорирует тело запроса", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/queue", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: otherTenant }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as QueuePayload;
    expect(body.items.every((item) => item.id !== "чужое")).toBe(true);
    expect(body.items).toHaveLength(2);
  });

  it("считает просрочку по sla_due_at, не меняя статус в базе", async () => {
    await testPool().query(
      `INSERT INTO escalations (
         tenant_id, conversation_id, reason, summary, draft, sources, status,
         sla_due_at, created_at, channel, result, trace_ref, is_shadow
       ) VALUES ($1, $2, 'нужен менеджер', 'Просроченное обращение', NULL,
         '[]'::jsonb, 'open', '2026-11-26T09:00:00.000Z',
         '2026-11-26T08:00:00.000Z', 'web', 'Просроченное обращение', $2, false)`,
      [tenantId, oldConversation],
    );
    const response = await GET(
      new Request("http://localhost/api/manager/queue", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as QueuePayload;
    const item = body.items.find(
      (entry) => entry.summary === "Просроченное обращение",
    );
    expect(item?.overdue).toBe(true);
    expect(item?.status).toBe("open");
  });

  it("не считает просрочкой закрытое и не просроченное обращение", async () => {
    await testPool().query(
      `INSERT INTO escalations (
         tenant_id, conversation_id, reason, summary, draft, sources, status,
         sla_due_at, created_at, channel, result, trace_ref, is_shadow
       ) VALUES ($1, $2, 'нужен менеджер', 'Закрытое обращение', NULL,
         '[]'::jsonb, 'closed', '2026-11-26T09:00:00.000Z',
         '2026-11-26T08:00:00.000Z', 'web', 'Закрытое обращение', $2, false)`,
      [tenantId, oldConversation],
    );
    const response = await GET(
      new Request("http://localhost/api/manager/queue", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as QueuePayload;
    const closed = body.items.find((entry) => entry.summary === "Закрытое обращение");
    const current = body.items.find((entry) => entry.summary === "Новое обращение");
    expect(closed?.overdue).toBe(false);
    expect(current?.overdue).toBe(false);
  });
});
