import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { GET as getMaxStatusRoute } from "@/app/api/max/status/route";
import {
  createChannelStateStore,
  createCoreClient,
  createMaxClient,
  createStatePool,
  startMaxAdapter,
  stopMaxAdapter,
  type AgentOutcome,
  type MaxUpdate,
} from "@/channels/max";

/**
 * Интеграционный тест среза 05.
 *
 * Поднимаются две локальные заглушки:
 * - Bot API MAX (`GET /updates`, `POST /messages`);
 * - ядро (`POST /agent/run`) по замороженному контракту `docs/api-contract.md` §5.
 *
 * Проверяется полный путь: входящее событие → нормализация → вызов ядра →
 * отправка ответа в тот же чат.
 */

const TOKEN = "INTEGRATION-MAX-TOKEN-xyz789";

/**
 * Адрес базы для тестов, которым нужен живой Postgres.
 *
 * Тест выполняется, только если задан `DATABASE_URL` — иначе пропускается.
 */
const databaseUrl = process.env.DATABASE_URL;

/** Уникальный суффикс slug, чтобы параллельные прогоны не сталкивались. */
function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type StubMax = {
  server: Server;
  baseUrl: string;
  sent: Array<{ chatId: string; text: string; at: number }>;
  updateRequests: Array<{ marker: number | null }>;
  authorizationHeaders: string[];
  queue: MaxUpdate[][];
  failNext: { status: number; message: string } | null;
};

type StubCore = {
  server: Server;
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

async function startStubMax(): Promise<StubMax> {
  const state: StubMax = {
    server: null as unknown as Server,
    baseUrl: "",
    sent: [],
    updateRequests: [],
    authorizationHeaders: [],
    queue: [],
    failNext: null,
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const auth = req.headers.authorization;
      if (typeof auth === "string") {
        state.authorizationHeaders.push(auth);
      }

      if (state.failNext) {
        const failure = state.failNext;
        state.failNext = null;
        res.statusCode = failure.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: "server.error", message: failure.message }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/updates") {
        const markerParam = url.searchParams.get("marker");
        state.updateRequests.push({
          marker: markerParam === null ? null : Number(markerParam),
        });
        const batch = state.queue.shift();
        if (!batch) {
          // Пустая пачка: короткая пауза, чтобы опрос не крутился вхолостую.
          setTimeout(() => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ updates: [], marker: 1 }));
          }, 20);
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ updates: batch, marker: 100 }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        const body = JSON.parse(rawBody) as { text?: string };
        state.sent.push({
          chatId: url.searchParams.get("chat_id") ?? "",
          text: body.text ?? "",
          at: Date.now(),
        });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: { body: { mid: "sent-mid" } } }));
        return;
      }

      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "not.found", message: "нет такого маршрута" }));
    });
  });

  const port = await listen(server);
  state.server = server;
  state.baseUrl = `http://127.0.0.1:${port}`;
  return state;
}

async function startStubCore(): Promise<StubCore> {
  const requests: Array<Record<string, unknown>> = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST" && req.url === "/agent/run") {
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        requests.push(body);
        const text = String(body.text ?? "");
        const outcome: AgentOutcome = text.includes("ESCALATE")
          ? {
              outcome: "escalate",
              answer: null,
              escalation: {
                id: "esc-1",
                reason: "no_confirmed_source",
                summary: "нет подтверждённого источника",
                draft: null,
              },
              steps: [],
            }
          : {
              outcome: "respond",
              answer: { text: "Подтверждённый ответ ядра", sources: [] },
              escalation: null,
              steps: [],
            };
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(outcome));
        return;
      }

      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "not.found", message: "нет такого маршрута" }));
    });
  });

  const port = await listen(server);
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}

function messageCreated(mid: string, chatId: number, text: string): MaxUpdate {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    message: {
      body: { mid, text },
      recipient: { chat_id: chatId },
    },
  } as MaxUpdate;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("условие не выполнилось за отведённое время");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const openStubs: Server[] = [];

afterEach(async () => {
  await stopMaxAdapter();
  await Promise.all(
    openStubs.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("интеграция MAX-канала с ядром", () => {
  it("проводит сообщение от события MAX до ответа в том же чате", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([messageCreated("mid-1", 777, "Сколько стоит KES?")]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
    });

    await waitFor(() => max.sent.length === 1);

    // Ядро получило нормализованное сообщение по контракту §5.
    expect(core.requests).toHaveLength(1);
    expect(core.requests[0]).toMatchObject({
      channel: "max",
      external_chat_id: "777",
      message_id: "mid-1",
      text: "Сколько стоит KES?",
      masked_fields_count: 0,
    });
    expect(String(core.requests[0]?.conversation_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Ответ ушёл в тот же чат.
    expect(max.sent[0]?.chatId).toBe("777");
    expect(max.sent[0]?.text).toBe("Подтверждённый ответ ядра");

    // Токен ушёл в заголовке авторизации и не попал в тело запросов.
    expect(max.authorizationHeaders.length).toBeGreaterThan(0);
    expect(max.authorizationHeaders.every((value) => value === TOKEN)).toBe(true);
  });

  it("передаёт в ядро замаскированный текст и счётчик замаскированных полей", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([messageCreated("mid-mask", 778, "почта client@example.com")]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
      mask: (text: string) => ({
        maskedText: text.replace("client@example.com", "⟦EMAIL_1⟧"),
        maskedFieldsCount: 1,
      }),
    });

    await waitFor(() => core.requests.length === 1);

    expect(core.requests[0]).toMatchObject({
      text: "почта ⟦EMAIL_1⟧",
      masked_fields_count: 1,
    });
  });

  it("уведомляет клиента о передаче вопроса менеджеру при результате escalate", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([messageCreated("mid-esc", 779, "ESCALATE меня")]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
    });

    await waitFor(() => max.sent.length === 1);

    // Уведомление безопасное: без сроков, без обещаний и без деталей
    // эскалации. Тишина в чате выглядит как поломка.
    const sent = max.sent[0];
    expect(sent?.text).toBe("Передал вопрос менеджеру, ответим в рабочее время.");
    expect(sent?.text).not.toContain("час");
    expect(sent?.chatId).toBe("779");
  });

  it("не отправляет ответ в MAX в режиме тени ни при каком результате", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([
      messageCreated("mid-shadow-respond", 780, "вопрос"),
      messageCreated("mid-shadow-escalate", 781, "ESCALATE меня"),
    ]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => true,
    });

    await waitFor(() => core.requests.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(max.sent).toHaveLength(0);
  });

  it("не создаёт второе обращение и второй ответ на повторное событие", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([
      messageCreated("mid-dup", 782, "один и тот же вопрос"),
      messageCreated("mid-dup", 782, "один и тот же вопрос"),
    ]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
    });

    await waitFor(() => max.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(core.requests).toHaveLength(1);
    expect(max.sent).toHaveLength(1);
  });

  it("отбрасывает пустое событие без chat_id и продолжает опрос", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([
      {
        update_type: "message_created",
        timestamp: 1_700_000_000_000,
        message: { body: { mid: "mid-empty", text: "без чата" }, recipient: { chat_id: null } },
      } as unknown as MaxUpdate,
    ]);
    max.queue.push([messageCreated("mid-after-empty", 783, "вопрос после пустого")]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
    });

    await waitFor(() => max.sent.length === 1);

    expect(core.requests).toHaveLength(1);
    expect(core.requests[0]).toMatchObject({ message_id: "mid-after-empty" });
  });

  it("соблюдает предел 2 сообщения в секунду на диалог", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([
      messageCreated("rl-1", 784, "первый"),
      messageCreated("rl-2", 784, "второй"),
      messageCreated("rl-3", 784, "третий"),
    ]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
    });

    await waitFor(() => max.sent.length === 3, 8000);

    const [first, second, third] = max.sent;
    // Первые два сообщения уходят сразу, третье — после паузы: за любую
    // секунду в диалог уходит не больше двух сообщений.
    expect(second!.at - first!.at).toBeLessThan(1000);
    expect(third!.at - first!.at).toBeGreaterThanOrEqual(950);
  });

  it("не показывает токен в сообщениях об ошибках провайдера", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    const logs: string[] = [];
    max.failNext = { status: 500, message: `провайдер вернул ошибку с токеном ${TOKEN}` };

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
      logger: {
        info: (message: string) => logs.push(message),
        warn: (message: string) => logs.push(message),
        error: (message: string) => logs.push(message),
      },
    });

    await waitFor(() => logs.length > 0);

    for (const line of logs) {
      expect(line).not.toContain(TOKEN);
    }
  });

  it("передаёт маркер опроса в следующий запрос и сохраняет его после события", async () => {
    const max = await startStubMax();
    const core = await startStubCore();
    openStubs.push(max.server, core.server);

    max.queue.push([messageCreated("mid-marker", 785, "вопрос")]);

    const coreClient = createCoreClient({ baseUrl: core.baseUrl });
    await startMaxAdapter({
      token: TOKEN,
      client: createMaxClient(TOKEN, { baseUrl: max.baseUrl }),
      runAgent: coreClient.runAgent,
      shadowMode: async () => false,
    });

    await waitFor(() => max.sent.length === 1);
    await waitFor(() => max.updateRequests.length >= 2);

    expect(max.updateRequests[0]?.marker).toBeNull();
    expect(max.updateRequests[1]?.marker).toBe(100);
  });
});

/**
 * Проверка маршрута статуса канала: демо показывает состояние подключения,
 * токен бота не раскрывается.
 *
 * Тест самодостаточен: он создаёт собственного арендатора с уникальным
 * slug, кладёт в `channel_state` состояние опроса и удаляет его в
 * `finally`. Раньше тест ждал пустого состояния и зависел от того, что
 * в общей базе никто не опрашивает MAX: при живом воркере он падал.
 */
describe.skipIf(!databaseUrl)("маршрут статуса канала MAX", () => {
  it("отдаёт состояние подключения без токена", async () => {
    const pool = createStatePool();
    const slug = `max-status-${uniqueSuffix()}`;
    const previousSlug = process.env.TENANT_SLUG;
    let tenantId: string | null = null;

    try {
      const created = await pool.query(
        `INSERT INTO tenants (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
         RETURNING id`,
        [slug, slug],
      );
      tenantId = String((created.rows[0] as { id?: string } | undefined)?.id);

      // Маршрут определяет арендатора из окружения: без переключения он
      // прочитал бы состояние другого арендатора.
      process.env.TENANT_SLUG = slug;

      const store = createChannelStateStore(pool, { tenantId });
      await store.save({
        marker: 4242,
        lastEventAt: "2026-11-27T10:00:00.000Z",
      });

      const response = await getMaxStatusRoute();
      const payload = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        running: true,
        lastMarker: 4242,
        shadowMode: expect.any(Boolean),
      });
      expect(JSON.stringify(payload)).not.toContain(TOKEN);
    } finally {
      process.env.TENANT_SLUG = previousSlug;
      if (tenantId) {
        await pool.query("DELETE FROM channel_state WHERE tenant_id = $1", [tenantId]);
      }
      await pool.query("DELETE FROM tenants WHERE slug = $1", [slug]);
      await pool.end();
    }
  });
});

/**
 * Проверка на живой базе: миграция `5000_channel_state` создаёт таблицу,
 * а маркер опроса переживает перезапуск адаптера.
 *
 * Тест самодостаточен: он создаёт собственного арендатора с уникальным
 * slug и удаляет его в `finally`, поэтому проходит на пустой базе с
 * применёнными миграциями и не зависит от данных других прогонов.
 *
 * Тест выполняется, только если задан `DATABASE_URL` — иначе он пропускается.
 */
describe.skipIf(!databaseUrl)("интеграция MAX-канала с базой", () => {
  it("сохраняет маркер опроса в channel_state и читает его обратно", async () => {
    const pool = createStatePool();
    const slug = `max-test-${uniqueSuffix()}`;
    let tenantId: string | null = null;

    try {
      // Арендатор создаётся до обращения к channel_state: таблица ссылается
      // на tenants, поэтому без арендатора строку состояния не записать.
      const created = await pool.query(
        `INSERT INTO tenants (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
         RETURNING id`,
        [slug, slug],
      );
      const tenantRow = created.rows[0] as { id?: string } | undefined;
      expect(tenantRow?.id).toBeTruthy();
      tenantId = String(tenantRow?.id);

      const store = createChannelStateStore(pool, { tenantId });

      await store.save({
        marker: 4242,
        lastEventAt: "2026-11-27T10:00:00.000Z",
      });

      const state = await store.load();
      expect(state.marker).toBe(4242);
      expect(state.lastEventAt).toBe("2026-11-27T10:00:00.000Z");
    } finally {
      // Удаление выполняется и при падении теста, иначе следующий прогон
      // упрётся в остатки предыдущего.
      if (tenantId) {
        await pool.query("DELETE FROM channel_state WHERE tenant_id = $1", [tenantId]);
      }
      await pool.query("DELETE FROM tenants WHERE slug = $1", [slug]);
      await pool.end();
    }
  });
});
