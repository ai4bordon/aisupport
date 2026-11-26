import { describe, expect, it } from "vitest";

import {
  createChannelStateStore,
  createMaxSession,
  handleMaxUpdate,
  handleMaxUpdates,
  rateLimitDelay,
  type AgentOutcome,
  type MaxClock,
  type MaxClient,
  type MaxUpdate,
  type PoolLike,
} from "@/channels/max";

/**
 * Юнит-тесты канала MAX.
 *
 * Время и паузы подменены (`MaxClock`), поэтому тесты не ждут реального
 * времени: лимит отправки проверяется по виртуальным часам.
 */

const TOKEN = "TEST-MAX-TOKEN-abc123";

function update(mid: string, chatId: number, text = "вопрос"): MaxUpdate {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    message: {
      body: { mid, text },
      recipient: { chat_id: chatId },
    },
  } as MaxUpdate;
}

const respondOutcome: AgentOutcome = {
  outcome: "respond",
  answer: { text: "Проверенный ответ", sources: [] },
  escalation: null,
  steps: [],
};

const escalateOutcome: AgentOutcome = {
  outcome: "escalate",
  answer: null,
  escalation: { id: "esc-1", reason: "no_confirmed_source", summary: "нет источника", draft: null },
  steps: [],
};

type VirtualClock = MaxClock & { advance: (ms: number) => void; sleeps: number[] };

function virtualClock(): VirtualClock {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function stubClient(): MaxClient & { sent: Array<{ chatId: string; text: string }> } {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    async getUpdates() {
      return { updates: [], marker: 1 };
    },
    async sendMessage(chatId: string, text: string) {
      sent.push({ chatId, text });
    },
  };
}

describe("MAX-канал: обработка события", () => {
  it("при результате respond отправляет ответ в тот же chat_id", async () => {
    const client = stubClient();
    const calls: unknown[] = [];
    const session = await createMaxSession({
      token: TOKEN,
      client,
      runAgent: async (input) => {
        calls.push(input);
        return respondOutcome;
      },
      shadowMode: async () => false,
    });

    await handleMaxUpdate(session, update("mid-1", 4242));

    expect(client.sent).toEqual([{ chatId: "4242", text: "Проверенный ответ" }]);
    expect(calls[0]).toMatchObject({
      channel: "max",
      externalChatId: "4242",
      messageId: "mid-1",
      text: "вопрос",
    });
  });

  it("при результате escalate отправки в MAX нет", async () => {
    const client = stubClient();
    let agentCalls = 0;
    const session = await createMaxSession({
      token: TOKEN,
      client,
      runAgent: async () => {
        agentCalls += 1;
        return escalateOutcome;
      },
      shadowMode: async () => false,
    });

    const handled = await handleMaxUpdate(session, update("mid-2", 4242));

    expect(handled).toBe(true);
    expect(agentCalls).toBe(1);
    expect(client.sent).toHaveLength(0);
  });

  it("в режиме тени отправки нет ни при каком результате", async () => {
    for (const outcome of [respondOutcome, escalateOutcome]) {
      const client = stubClient();
      let agentCalls = 0;
      const session = await createMaxSession({
        token: TOKEN,
        client,
        runAgent: async () => {
          agentCalls += 1;
          return outcome;
        },
        shadowMode: async () => true,
      });

      await handleMaxUpdate(session, update(`mid-shadow-${outcome.outcome}`, 4242));

      expect(agentCalls).toBe(1);
      expect(client.sent).toHaveLength(0);
    }
  });

  it("повторное событие с тем же идентификатором не создаёт второе обращение", async () => {
    const client = stubClient();
    let agentCalls = 0;
    const session = await createMaxSession({
      token: TOKEN,
      client,
      runAgent: async () => {
        agentCalls += 1;
        return respondOutcome;
      },
      shadowMode: async () => false,
    });

    await handleMaxUpdates(session, [update("mid-dup", 4242), update("mid-dup", 4242)]);

    expect(agentCalls).toBe(1);
    expect(client.sent).toHaveLength(1);
  });

  it("пустое событие без chat_id отбрасывается и не роняет обработку", async () => {
    const client = stubClient();
    let agentCalls = 0;
    const session = await createMaxSession({
      token: TOKEN,
      client,
      runAgent: async () => {
        agentCalls += 1;
        return respondOutcome;
      },
      shadowMode: async () => false,
    });

    const empty = {
      update_type: "message_created",
      timestamp: 1_700_000_000_000,
      message: { body: { mid: "mid-empty", text: "без чата" }, recipient: { chat_id: null } },
    } as unknown as MaxUpdate;

    const handled = await handleMaxUpdates(session, [empty, update("mid-after", 4242)]);

    expect(handled).toEqual(["mid-after"]);
    expect(agentCalls).toBe(1);
  });
});

describe("MAX-канал: лимит отправки", () => {
  it("вычисляет паузу, когда за секунду уже ушло два сообщения", () => {
    expect(rateLimitDelay([], 0)).toBe(0);
    expect(rateLimitDelay([0], 100)).toBe(0);
    expect(rateLimitDelay([0, 100], 200)).toBe(800);
    expect(rateLimitDelay([0, 100], 1000)).toBe(0);
  });

  it("не отправляет больше двух сообщений в секунду на диалог", async () => {
    const clock = virtualClock();
    const client = stubClient();
    const sendTimes: number[] = [];

    const session = await createMaxSession({
      token: TOKEN,
      client,
      clock,
      runAgent: async () => respondOutcome,
      shadowMode: async () => false,
      sendMessage: async (chatId: string, text: string) => {
        sendTimes.push(clock.now());
        client.sent.push({ chatId, text });
      },
    });

    await handleMaxUpdates(session, [
      update("m1", 4242),
      update("m2", 4242),
      update("m3", 4242),
    ]);

    expect(sendTimes).toHaveLength(3);
    // Первые два сообщения уходят сразу, третье — после паузы до конца окна.
    expect(sendTimes[1]! - sendTimes[0]!).toBeLessThan(1000);
    expect(sendTimes[2]! - sendTimes[0]!).toBeGreaterThanOrEqual(1000);
  });

  it("лимит применяется к каждому диалогу отдельно", async () => {
    const clock = virtualClock();
    const client = stubClient();
    const sendTimes: Array<{ chatId: string; at: number }> = [];

    const session = await createMaxSession({
      token: TOKEN,
      client,
      clock,
      runAgent: async () => respondOutcome,
      shadowMode: async () => false,
      sendMessage: async (chatId: string, text: string) => {
        sendTimes.push({ chatId, at: clock.now() });
        client.sent.push({ chatId, text });
      },
    });

    await handleMaxUpdates(session, [
      update("m1", 111),
      update("m2", 111),
      update("m3", 222),
    ]);

    const first = sendTimes.find((item) => item.chatId === "111" && item.at === 0);
    const other = sendTimes.find((item) => item.chatId === "222");
    expect(first).toBeDefined();
    // Второй диалог не ждёт лимита первого.
    expect(other?.at).toBe(0);
  });
});

describe("MAX-канал: токен", () => {
  it("не публикует токен в журналах и в сообщениях об ошибках", async () => {
    const logs: string[] = [];
    const session = await createMaxSession({
      token: TOKEN,
      client: stubClient(),
      runAgent: async () => respondOutcome,
      shadowMode: async () => false,
      logger: {
        info: (message: string) => logs.push(message),
        warn: (message: string) => logs.push(message),
        error: (message: string) => logs.push(message),
      },
    });

    await handleMaxUpdate(session, update("mid-token", 4242));

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(TOKEN);
    }
  });

  it("вырезает токен из произвольного текста ошибки", async () => {
    const session = await createMaxSession({
      token: TOKEN,
      client: stubClient(),
      runAgent: async () => respondOutcome,
      shadowMode: async () => false,
    });

    const line = session.log(`провайдер вернул ошибку с токеном ${TOKEN}`);
    expect(line).not.toContain(TOKEN);
    expect(line).toContain("[hidden]");
  });
});

/**
 * Хранилище состояния канала: маркер опроса переживает перезапуск адаптера,
 * поэтому перезапуск не теряет события.
 */
type Row = Record<string, unknown>;

function stubPool(rows: Row[] = []): PoolLike & { saved: Array<{ text: string; values: unknown[] }> } {
  const saved: Array<{ text: string; values: unknown[] }> = [];
  return {
    saved,
    async query(text: string, values: unknown[] = []) {
      if (text.includes("SELECT")) {
        return { rows };
      }
      saved.push({ text, values });
      return { rows: [] };
    },
  };
}

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("хранилище состояния канала", () => {
  it("читает маркер и время последнего события", async () => {
    const pool = stubPool([
      { marker: 42, last_event_at: "2026-11-27T10:00:00.000Z", shadow_mode: true },
    ]);
    const store = createChannelStateStore(pool, { tenantId: TENANT });

    const state = await store.load();

    expect(state.marker).toBe(42);
    expect(state.lastEventAt).toBe("2026-11-27T10:00:00.000Z");
    expect(state.shadowMode).toBe(true);
  });

  it("возвращает пустое состояние, если строки нет", async () => {
    const store = createChannelStateStore(stubPool(), { tenantId: TENANT });

    const state = await store.load();

    expect(state.marker).toBeNull();
    expect(state.lastEventAt).toBeNull();
    expect(state.shadowMode).toBe(false);
  });

  it("сохраняет состояние с арендатором и каналом", async () => {
    const pool = stubPool();
    const store = createChannelStateStore(pool, { tenantId: TENANT });

    await store.save({ marker: 7, lastEventAt: "2026-11-27T10:00:00.000Z", shadowMode: false });

    expect(pool.saved).toHaveLength(1);
    expect(pool.saved[0]?.values).toEqual([TENANT, "max", "", 7, "2026-11-27T10:00:00.000Z", false]);
    expect(pool.saved[0]?.text).not.toContain("token");
  });
});
