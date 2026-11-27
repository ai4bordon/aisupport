/**
 * Тесты раздела кабинета менеджера «Аналитика».
 *
 * Проверяются три вещи:
 * 1) бренд-раскладка: в файлах раздела нет сырых цветов, а цвета и шрифт
 *    берутся только из токенов `src/app/styles/tokens.css`;
 * 2) явные состояния раздела: загрузка, ошибка, пусто — и сами метрики
 *    стоимости диалога, автозакрытия, первого ответа и пробелов базы знаний;
 * 3) маршрут данных `/api/manager/analytics`: барьер доступа менеджера,
 *    арендатор определяется сервером, агрегаты считаются по записям трасс.
 *
 * Команда проверки: `npm run test -- tests/manager/ui-analytics.test.ts`
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/manager/analytics/route";
import { AnalyticsClient } from "@/app/manager/analytics/analytics-client";
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
const TENANT_SLUG = "test-manager-ui-analytics";
const MANAGER_CODE = "test-manager-code-ui-analytics";
const SESSION_SECRET = "test-manager-secret-ui-analytics";

/** Тело ответа маршрута данных раздела. */
type AnalyticsPayload = {
  data_origin: "demo_synthetic" | "customer";
  origin_note: string;
  cost: {
    dialogs: number;
    total_rub: number;
    avg_rub: number;
    min_rub: number;
    max_rub: number;
    tokens_in: number;
    tokens_out: number;
  };
  auto_close: {
    dialogs_total: number;
    closed_by_agent: number;
    share: number;
    without_manager: number;
    with_manager_confirmed_quote: number;
  };
  first_response: {
    samples: number;
    avg_ms: number;
    target_ms: number;
    meets_target: boolean;
  };
  knowledge_gaps: Array<{
    intent: string;
    node: string;
    count: number;
  }>;
};

const EMPTY_PAYLOAD: AnalyticsPayload = {
  data_origin: "customer",
  origin_note: "Данные установки заказчика.",
  cost: {
    dialogs: 0,
    total_rub: 0,
    avg_rub: 0,
    min_rub: 0,
    max_rub: 0,
    tokens_in: 0,
    tokens_out: 0,
  },
  auto_close: {
    dialogs_total: 0,
    closed_by_agent: 0,
    share: 0,
    without_manager: 0,
    with_manager_confirmed_quote: 0,
  },
  first_response: {
    samples: 0,
    avg_ms: 0,
    target_ms: 120000,
    meets_target: false,
  },
  knowledge_gaps: [],
};

const SAMPLE_PAYLOAD: AnalyticsPayload = {
  data_origin: "demo_synthetic",
  origin_note: "Синтетические демонстрационные данные стенда, не данные заказчика.",
  cost: {
    dialogs: 3,
    total_rub: 3.75,
    avg_rub: 1.25,
    min_rub: 0.75,
    max_rub: 2,
    tokens_in: 300,
    tokens_out: 120,
  },
  auto_close: {
    dialogs_total: 3,
    closed_by_agent: 2,
    share: 0.6667,
    without_manager: 1,
    with_manager_confirmed_quote: 1,
  },
  first_response: {
    samples: 2,
    avg_ms: 52500,
    target_ms: 120000,
    meets_target: true,
  },
  knowledge_gaps: [{ intent: "howto", node: "no_source", count: 2 }],
};

function mockAnalyticsResponse(payload: AnalyticsPayload = SAMPLE_PAYLOAD): void {
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

/**
 * Очистка строк арендатора перед новой фикстурой.
 *
 * Общий помощник `resetTenant` чистит не все таблицы: строки `documents` он
 * не удаляет, а на них висит внешний ключ на `conversations`. Без этой
 * очистки вторая фикстура падала бы на нарушении внешнего ключа.
 */
async function clearTenantRows(slug: string): Promise<void> {
  const existing = await testPool().query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [slug],
  );
  const tenantId = existing.rows[0]?.id;
  if (!tenantId) return;

  await testPool().query("DELETE FROM documents WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM escalations WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM agent_steps WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM messages WHERE tenant_id = $1", [tenantId]);
}

/**
 * Фикстура раздела: три диалога с трассами.
 *
 * Диалог 1 — ответ агента без менеджера (стоимость 1 рубль).
 * Диалог 2 — эскалация менеджеру (стоимость 2 рубля), источник не подтверждён.
 * Диалог 3 — КП, подтверждённое менеджером (стоимость 0,75 рубля).
 *
 * Ожидаемые агрегаты посчитаны вручную по этой фикстуре:
 * - стоимость диалога: всего 3,75 рубля; среднее 1,25; минимум 0,75; максимум 2;
 * - автозакрытие: 2 из 3 диалогов (1 без менеджера и 1 с подтверждённым КП);
 * - первый ответ агента: 60 с и 45 с → среднее 52,5 с.
 *
 * Возвращает идентификатор арендатора: его создаёт `resetTenant`.
 */
async function seedAnalyticsData(): Promise<string> {
  await clearTenantRows(TENANT_SLUG);
  const tenantId = await resetTenant(TENANT_SLUG);
  const conversations = await testPool().query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, status)
     VALUES ($1, 'web', 'closed'), ($1, 'web', 'escalate'), ($1, 'web', 'closed')
     RETURNING id`,
    [tenantId],
  );
  const ids = conversations.rows.map((row) => row.id);
  const [auto, escalated, quote] = [ids[0] ?? "", ids[1] ?? "", ids[2] ?? ""];

  const stepInsert = `INSERT INTO agent_steps (
       tenant_id, conversation_id, node, endpoint, tokens_in, tokens_out,
       cost_rub, latency_ms, metadata, source_ids, outcome, model, step_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '[]'::jsonb, $10, $11, $12)`;

  // Диалог 1: ответ агента, менеджер не участвовал.
  await testPool().query(stepInsert, [
    tenantId,
    auto,
    "respond",
    "POST /agent/respond",
    100,
    40,
    1,
    1200,
    JSON.stringify({ intent: "howto" }),
    "respond",
    "deepseek-v4.1-flash",
    "respond:1",
  ]);

  // Диалог 2: эскалация — подтверждённого источника нет.
  await testPool().query(stepInsert, [
    tenantId,
    escalated,
    "no_source",
    null,
    0,
    0,
    0,
    900,
    JSON.stringify({ reason: "no_confirmed_source", intent: "howto" }),
    "escalate",
    null,
    "no_source:1",
  ]);
  await testPool().query(stepInsert, [
    tenantId,
    escalated,
    "escalate",
    null,
    0,
    0,
    2,
    1500,
    JSON.stringify({ reason: "no_confirmed_source", intent: "howto" }),
    "escalate",
    null,
    "escalate:1",
  ]);

  // Диалог 3: КП, подтверждённое менеджером одним нажатием.
  await testPool().query(stepInsert, [
    tenantId,
    quote,
    "respond",
    "POST /agent/respond",
    200,
    80,
    0.75,
    2100,
    JSON.stringify({ intent: "quote" }),
    "respond",
    "deepseek-v4.1-flash",
    "respond:1",
  ]);

  // Переписка: время первого ответа агента считается по сообщениям.
  await testPool().query(
    `INSERT INTO messages (
       tenant_id, conversation_id, client_message_id, role, text_masked, sources, created_at
     ) VALUES
       ($1, $2, gen_random_uuid(), 'client', 'Вопрос', '[]'::jsonb, '2026-11-27T10:00:00.000Z'),
       ($1, $2, gen_random_uuid(), 'agent',  'Ответ',  '[]'::jsonb, '2026-11-27T10:01:00.000Z'),
       ($1, $3, gen_random_uuid(), 'client', 'Вопрос', '[]'::jsonb, '2026-11-27T11:00:00.000Z'),
       ($1, $3, gen_random_uuid(), 'manager','Ответ', '[]'::jsonb, '2026-11-27T11:02:00.000Z'),
       ($1, $4, gen_random_uuid(), 'client', 'Вопрос', '[]'::jsonb, '2026-11-27T12:00:00.000Z'),
       ($1, $4, gen_random_uuid(), 'agent',  'Ответ', '[]'::jsonb, '2026-11-27T12:00:45.000Z')`,
    [tenantId, auto, escalated, quote],
  );

  // Диалог 2: дело стоит в очереди менеджера — агент закрыть его не мог.
  await testPool().query(
    `INSERT INTO escalations (
       tenant_id, conversation_id, reason, summary, draft, sources, status,
       sla_due_at, created_at, channel, result, trace_ref, is_shadow
     ) VALUES ($1, $2, 'no_confirmed_source', 'Нужен менеджер', 'Черновик',
       '[]'::jsonb, 'open', NULL, '2026-11-27T11:00:00.000Z', 'web',
       'Черновик', $2, false)`,
    [tenantId, escalated],
  );

  // Диалог 3: выпущено КП и менеджер его подтвердил.
  await testPool().query(
    `INSERT INTO documents (tenant_id, conversation_id, kind, number, amount, vat)
     VALUES ($1, $2, 'quote', 'КП-20261127-001', 60000, 0)`,
    [tenantId, quote],
  );
  await testPool().query(
    `INSERT INTO escalations (
       tenant_id, conversation_id, reason, summary, draft, sources, status,
       sla_due_at, created_at, channel, result, trace_ref, is_shadow
     ) VALUES ($1, $2, 'quote_issued', 'КП выпущено', 'Черновик',
       '[]'::jsonb, 'closed', NULL, '2026-11-27T12:00:00.000Z', 'web',
       'КП подтверждено', $2, false)`,
    [tenantId, quote],
  );

  return tenantId;
}

describe("бренд-раскладка раздела аналитики", () => {
  it("в файлах раздела нет сырых цветов", async () => {
    const files = [
      "src/app/manager/analytics/page.tsx",
      "src/app/manager/analytics/analytics-client.tsx",
      "src/app/manager/analytics/styles.css",
      "src/app/api/manager/analytics/route.ts",
    ];
    const contents = await Promise.all(
      files.map((file) => readFile(resolve(REPO_ROOT, file), "utf8")),
    );
    const source = contents.join("\n");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });

  it("цвета и шрифт берутся только из фирменных токенов", async () => {
    const styles = await readFile(
      resolve(REPO_ROOT, "src/app/manager/analytics/styles.css"),
      "utf8",
    );
    const tokens = await readFile(
      resolve(REPO_ROOT, "src/app/styles/tokens.css"),
      "utf8",
    );
    const declared = new Set(
      [...tokens.matchAll(/(--sl-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string),
    );

    expect(styles).toContain("var(--sl-font-sans)");
    const used = new Set(
      [...styles.matchAll(/var\((--sl-[a-z0-9-]+)\)/g)].map((match) => match[1] as string),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      expect(declared.has(name), `токен ${name} не объявлен в tokens.css`).toBe(true);
    }
  });

  it("показывает видимый фокус клавиатурной навигации", async () => {
    const styles = await readFile(
      resolve(REPO_ROOT, "src/app/manager/analytics/styles.css"),
      "utf8",
    );
    expect(styles).toContain(":focus-visible");
    expect(styles).toMatch(/outline:\s*(?!none)/);
  });
});

describe("состояния раздела аналитики", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("показывает состояние загрузки", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(createElement(AnalyticsClient));
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем аналитику");
  });

  it("показывает состояние ошибки", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Сеть недоступна")));
    render(createElement(AnalyticsClient));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось загрузить аналитику",
    );
  });

  it("показывает пустое состояние, когда обращений ещё не было", async () => {
    mockAnalyticsResponse(EMPTY_PAYLOAD);
    render(createElement(AnalyticsClient));
    expect(await screen.findByText("Обращений пока нет")).toBeInTheDocument();
  });

  it("использует семантическую разметку и доступные имена", async () => {
    mockAnalyticsResponse();
    render(createElement(AnalyticsClient));
    expect(
      await screen.findByRole("main", { name: "Аналитика обращений" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Стоимость диалога" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Доля автозакрытия" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Средний первый ответ" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Пробелы базы знаний" })).toBeInTheDocument();
  });

  it("показывает стоимость диалога: среднее, минимум и максимум", async () => {
    mockAnalyticsResponse();
    render(createElement(AnalyticsClient));
    const region = await screen.findByRole("region", { name: "Стоимость диалога" });
    expect(within(region).getByText("1,25 ₽")).toBeInTheDocument();
    expect(within(region).getByText("0,75 ₽")).toBeInTheDocument();
    expect(within(region).getByText("2,00 ₽")).toBeInTheDocument();
  });

  it("показывает долю автозакрытия по обоим вариантам заказчика", async () => {
    mockAnalyticsResponse();
    render(createElement(AnalyticsClient));
    const region = await screen.findByRole("region", { name: "Доля автозакрытия" });
    expect(within(region).getByText("67 %")).toBeInTheDocument();
    expect(
      within(region).getByText(/1 обращение закрыл агент без менеджера/i),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(/1 обращение закрыто по подтверждённому КП/i),
    ).toBeInTheDocument();
  });

  it("показывает средний первый ответ и сравнение с ориентиром", async () => {
    mockAnalyticsResponse();
    render(createElement(AnalyticsClient));
    const region = await screen.findByRole("region", { name: "Средний первый ответ" });
    expect(within(region).getByText("53 с")).toBeInTheDocument();
    expect(within(region).getByText(/ориентир 2 минуты/i)).toBeInTheDocument();
  });

  it("показывает пробелы базы знаний по фактическим трассам", async () => {
    mockAnalyticsResponse();
    render(createElement(AnalyticsClient));
    const region = await screen.findByRole("region", { name: "Пробелы базы знаний" });
    expect(within(region).getByText("howto")).toBeInTheDocument();
    expect(within(region).getByText(/2 обращения/i)).toBeInTheDocument();
  });

  it("помечает синтетические данные стенда", async () => {
    mockAnalyticsResponse();
    render(createElement(AnalyticsClient));
    expect(
      await screen.findByText(/синтетические демонстрационные данные/i),
    ).toBeInTheDocument();
  });

  it("не выдаёт пустые метрики за измеренные", async () => {
    mockAnalyticsResponse(EMPTY_PAYLOAD);
    render(createElement(AnalyticsClient));
    expect(await screen.findByText("Обращений пока нет")).toBeInTheDocument();
    expect(screen.queryByText("67 %")).not.toBeInTheDocument();
  });
});

describe("маршрут данных раздела аналитики", () => {
  let cookie = "";
  let tenantId = "";

  beforeAll(async () => {
    await ensureSchema();
    cookie = await managerCookie();
  });

  beforeEach(async () => {
    tenantId = await seedAnalyticsData();
  });

  afterAll(async () => {
    await closePool();
  });

  it("не пускает запрос без cookie менеджера", async () => {
    const response = await GET(new Request("http://localhost/api/manager/analytics"));
    expect(response.status).toBe(401);
  });

  it("считает стоимость диалога по трассам: среднее, минимум и максимум", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/analytics", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AnalyticsPayload;
    // Фикстура: 1 + 2 + 0,75 = 3,75 рубля на трёх диалогах.
    // Минимум — КП (0,75), максимум — диалог с эскалацией (2).
    expect(body.cost.dialogs).toBe(3);
    expect(body.cost.total_rub).toBeCloseTo(3.75, 4);
    expect(body.cost.avg_rub).toBeCloseTo(1.25, 4);
    expect(body.cost.min_rub).toBeCloseTo(0.75, 4);
    expect(body.cost.max_rub).toBeCloseTo(2, 4);
    expect(body.cost.tokens_in).toBe(300);
    expect(body.cost.tokens_out).toBe(120);
  });

  it("считает долю автозакрытия по обоим вариантам заказчика", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/analytics", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as AnalyticsPayload;
    // Вариант 1: ответ без менеджера — диалог 1.
    // Вариант 2: КП, подтверждённое менеджером, — диалог 3.
    // Диалог 2 стоит в очереди менеджера: агент его не закрывал.
    expect(body.auto_close.dialogs_total).toBe(3);
    expect(body.auto_close.without_manager).toBe(1);
    expect(body.auto_close.with_manager_confirmed_quote).toBe(1);
    expect(body.auto_close.closed_by_agent).toBe(2);
    expect(body.auto_close.share).toBeCloseTo(2 / 3, 4);
  });

  it("считает средний первый ответ по сообщениям диалогов", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/analytics", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as AnalyticsPayload;
    // Первый ответ агента: 60 с и 45 с → среднее 52,5 с.
    expect(body.first_response.samples).toBe(2);
    expect(body.first_response.avg_ms).toBeCloseTo(52_500, 0);
    expect(body.first_response.target_ms).toBe(120_000);
    expect(body.first_response.meets_target).toBe(true);
  });

  it("собирает пробелы базы знаний по трассам, а не по выдуманным темам", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/analytics", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as AnalyticsPayload;
    // Диалог 2 записал два шага с причиной `no_confirmed_source`:
    // `no_source` (источника нет) и `escalate` (поэтому ушло менеджеру).
    expect(body.knowledge_gaps).toEqual([
      { intent: "howto", node: "no_source", count: 1 },
      { intent: "howto", node: "escalate", count: 1 },
    ]);
  });

  it("определяет арендатора на сервере и игнорирует тело запроса", async () => {
    const other = await testPool().query<{ id: string }>(
      `INSERT INTO tenants (slug, name)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [`${TENANT_SLUG}-other`, "Другой арендатор"],
    );
    const response = await GET(
      new Request("http://localhost/api/manager/analytics?tenant_id=other", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: other.rows[0]?.id }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AnalyticsPayload;
    expect(body.cost.dialogs).toBe(3);
  });

  it("возвращает нулевые агрегаты, когда трасс ещё нет", async () => {
    await testPool().query("DELETE FROM agent_steps WHERE tenant_id = $1", [tenantId]);
    await testPool().query("DELETE FROM messages WHERE tenant_id = $1", [tenantId]);
    const response = await GET(
      new Request("http://localhost/api/manager/analytics", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AnalyticsPayload;
    expect(body.cost.dialogs).toBe(0);
    expect(body.cost.avg_rub).toBe(0);
    expect(body.auto_close.dialogs_total).toBe(0);
    expect(body.auto_close.share).toBe(0);
    expect(body.first_response.samples).toBe(0);
    expect(body.knowledge_gaps).toEqual([]);
  });

  it("помечает происхождение данных отчёта", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/analytics", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as AnalyticsPayload;
    expect(body.data_origin).toBe("customer");
    expect(body.origin_note.length).toBeGreaterThan(0);
  });
});
