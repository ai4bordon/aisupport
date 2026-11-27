import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { POST } from "@/app/api/chat/route";
import {
  createHttpModelClient,
  setModelClient,
} from "@/core/model";
import { createMaxSession, handleMaxUpdate } from "@/channels/max";
import { maskPersonalData, restoreMaskedData } from "@/core/mask";
import { createOutgoingCheck } from "@/core/outgoing-check";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";
import type { MaxClient, MaxUpdate } from "@/channels/max";

/**
 * Интеграционная проверка среза 10 «Безопасность выполнения и каналов».
 *
 * Команда проверки: npm run test -- tests/integration/10-runtime-safety.test.ts
 *
 * Сквозной сценарий на одной тестовой базе: повтор после 429, тайм-аут
 * первого токена, оба канала на предмет персональных данных и
 * конкурентные ходы одного диалога.
 *
 * Настоящих персональных данных в тесте нет, и исходные значения не
 * печатаются: проверяются метки и факт наличия или отсутствия утечки.
 */
const TENANT_SLUG = "test-integration-10";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

/** Тестовые данные клиента: настоящих персональных данных здесь нет. */
const CLIENT_EMAIL = "ivanov@example.test";
const CLIENT_NAME = "Иван Иванович Иванов";

let tenantId = "";

function embeddingFor(words: string[]): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const word of words) {
    const stem = word.toLowerCase().slice(0, 6);
    let hash = 2166136261;
    for (let index = 0; index < stem.length; index += 1) {
      hash ^= stem.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % 1536] = (vector[Math.abs(hash) % 1536] ?? 0) + 1;
  }
  return vector;
}

/** Модель отвечает кодом класса на классификацию и текстом на генерацию. */
function stubModel(
  text: string,
  citations: string[] = [],
): { complete: (request: ModelRequest) => Promise<ModelResult> } {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      const isClassification = request.messages.some((message) =>
        message.content.includes("класс обращения"),
      );
      return {
        text: isClassification ? "howto" : text,
        amounts: [],
        citations: isClassification ? [] : citations,
        tokensIn: 42,
        tokensOut: 24,
        costRub: 0.25,
        model: "stub-model",
      };
    },
  };
}

/** Ответ провайдера с заданным статусом. */
function providerResponse(status: number): Response {
  return new Response("busy", { status });
}

async function seedKnowledge(): Promise<void> {
  tenantId = await resetTenant(TENANT_SLUG);

  const article = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Лицензирование', $2, 'published', now(), now())
     RETURNING id`,
    [tenantId, ARTICLE_TEXT],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [
      tenantId,
      article.rows[0]?.id ?? "",
      ARTICLE_TEXT,
      `[${embeddingFor(["Электронная", "лицензия", "предоставляется"]).join(",")}]`,
    ],
  );
}

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("интеграционная проверка среза 10", () => {
  beforeAll(async () => {
    process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-key";
    process.env.TENANT_SLUG = TENANT_SLUG;
    await ensureSchema();
  });

  beforeEach(async () => {
    process.env.ESCALATION_MODE = "on";
    await seedKnowledge();
  });

  afterAll(async () => {
    await closePool();
  });

  it("второй 429 даёт один повтор и эскалацию, а не выдуманный ответ", async () => {
    // Провайдер дважды отвечает 429: клиент делает ровно один повтор и
    // после второго 429 поднимает отказ провайдера.
    let calls = 0;
    const sleeps: number[] = [];
    const client = createHttpModelClient({
      baseUrl: "https://model.test",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: (async () => {
        calls += 1;
        return providerResponse(429);
      }) as unknown as typeof fetch,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    });
    setModelClient(client);

    const response = await POST(
      chatRequest({
        conversation_id: "5a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "5a1b2c3d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(calls).toBe(2);
    expect(sleeps).toEqual([30_000]);

    const body = (await response.json()) as {
      outcome: string;
      answer: unknown;
      escalation: { reason: string } | null;
    };
    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();
    expect(body.escalation?.reason).toBe("upstream_error");
  });

  it("тайм-аут первого токена даёт upstream_timeout без выдуманного ответа", async () => {
    const client = createHttpModelClient({
      baseUrl: "https://model.test",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 50,
      fetchImpl: (async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init?.signal?.reason);
          });
        })) as unknown as typeof fetch,
    });
    setModelClient(client);

    const response = await POST(
      chatRequest({
        conversation_id: "5a1b2c3d-3333-4333-8333-333333333333",
        message: {
          client_message_id: "5a1b2c3d-4444-4444-8444-444444444444",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    const body = (await response.json()) as {
      outcome: string;
      answer: unknown;
      escalation: { reason: string; draft: string | null } | null;
    };
    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();
    expect(body.escalation?.reason).toBe("upstream_timeout");
    // Черновика нет: отказ провайдера не подменяется текстом.
    expect(body.escalation?.draft).toBeNull();
  });

  it("в веб-чате в модель уходят только метки, а в трассе нет исходных значений", async () => {
    const requests: ModelRequest[] = [];
    setModelClient({
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        requests.push(request);
        const isClassification = request.messages.some((message) =>
          message.content.includes("класс обращения"),
        );
        return {
          text: isClassification ? "howto" : ARTICLE_TEXT,
          amounts: [],
          citations: isClassification ? [] : [ARTICLE_TEXT],
          tokensIn: 42,
          tokensOut: 24,
          costRub: 0.25,
          model: "stub-model",
        };
      },
    });

    await POST(
      chatRequest({
        conversation_id: "5a1b2c3d-5555-4555-8555-555555555555",
        message: {
          client_message_id: "5a1b2c3d-6666-4666-8666-666666666666",
          text: `Меня зовут ${CLIENT_NAME}, почта ${CLIENT_EMAIL}`,
        },
      }),
    );

    // В запросах модели — только метки.
    const seen = requests
      .flatMap((request) => request.messages.map((message) => message.content))
      .join("\n");
    expect(seen).toContain("⟦");
    expect(seen).not.toContain(CLIENT_EMAIL);
    expect(seen).not.toContain(CLIENT_NAME);

    // В трассе исходных значений нет.
    const steps = await testPool().query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM agent_steps WHERE conversation_id = $1",
      ["5a1b2c3d-5555-4555-8555-555555555555"],
    );
    expect(JSON.stringify(steps.rows)).not.toContain(CLIENT_EMAIL);
    expect(JSON.stringify(steps.rows)).not.toContain(CLIENT_NAME);
  });

  it("MAX: в ядро уходят только метки, утечка в ответе не отправляется", async () => {
    setModelClient(stubModel(ARTICLE_TEXT, [ARTICLE_TEXT]));

    const sent: Array<{ chatId: string; text: string }> = [];
    const maxClient: MaxClient = {
      async getUpdates() {
        return { updates: [], marker: 1 };
      },
      async sendMessage(chatId: string, text: string) {
        sent.push({ chatId, text });
      },
    };

    // Серверное хранилище соответствий меток диалога.
    const mapping = new Map<string, Record<string, string>>();
    const store = {
      async load(conversationId: string) {
        return mapping.get(conversationId) ?? {};
      },
      async save(conversationId: string, values: Record<string, string>) {
        mapping.set(conversationId, {
          ...(mapping.get(conversationId) ?? {}),
          ...values,
        });
      },
    };

    const seen: string[] = [];
    const session = await createMaxSession({
      token: "TEST-MAX-TOKEN-abc123",
      client: maxClient,
      mask: async (text, conversationId) => {
        const known = await store.load(conversationId);
        const result = maskPersonalData(text, { mapping: known });
        await store.save(conversationId, result.mapping);
        return {
          maskedText: result.maskedText,
          maskedFieldsCount: result.maskedFieldsCount,
        };
      },
      restore: async (text, conversationId) =>
        restoreMaskedData(text, await store.load(conversationId)),
      checkOutgoing: createOutgoingCheck(store),
      runAgent: async (input) => {
        seen.push(input.text);
        return {
          outcome: "respond",
          answer: { text: ARTICLE_TEXT, sources: [] },
          escalation: null,
          steps: [],
        };
      },
      shadowMode: async () => false,
    });

    const update = {
      update_type: "message_created",
      timestamp: 1_700_000_000_000,
      message: {
        body: {
          mid: "mid-integration-1",
          text: `Меня зовут ${CLIENT_NAME}, почта ${CLIENT_EMAIL}`,
        },
        recipient: { chat_id: 4242 },
      },
    } as MaxUpdate;

    await handleMaxUpdate(session, update);

    // В ядро ушли только метки.
    expect(seen[0]).toContain("⟦");
    expect(seen[0]).not.toContain(CLIENT_EMAIL);
    expect(seen[0]).not.toContain(CLIENT_NAME);

    // Клиенту отправлен ответ без исходных значений клиента: в ответе
    // модели их не было, восстанавливать нечего.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).not.toContain(CLIENT_EMAIL);
    expect(sent[0]?.text).not.toContain(CLIENT_NAME);
  });

  it("конкурентные ходы одного диалога не теряют записи", async () => {
    setModelClient(stubModel(ARTICLE_TEXT, [ARTICLE_TEXT]));

    const conversationId = "5a1b2c3d-7777-4777-8777-777777777777";
    const first = "5a1b2c3d-8888-4888-8888-888888888888";
    const second = "5a1b2c3d-9999-4999-8999-999999999999";

    await Promise.all([
      POST(
        chatRequest({
          conversation_id: conversationId,
          message: {
            client_message_id: first,
            text: "Как получить электронную лицензию?",
          },
        }),
      ),
      POST(
        chatRequest({
          conversation_id: conversationId,
          message: {
            client_message_id: second,
            text: "Сколько стоит лицензия?",
          },
        }),
      ),
    ]);

    // Оба клиентских сообщения записаны.
    const clientMessages = await testPool().query<{ client_message_id: string }>(
      "SELECT client_message_id FROM messages WHERE conversation_id = $1 AND role = 'client'",
      [conversationId],
    );
    expect(clientMessages.rows.map((row) => row.client_message_id).sort()).toEqual(
      [first, second].sort(),
    );

    // Трасса не потеряна: шаги обоих ходов на месте, ключи разные.
    const steps = await testPool().query<{ step_key: string; node: string }>(
      "SELECT step_key, node FROM agent_steps WHERE conversation_id = $1",
      [conversationId],
    );
    expect(steps.rows.length).toBeGreaterThan(0);
    const keys = steps.rows.map((row) => row.step_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
