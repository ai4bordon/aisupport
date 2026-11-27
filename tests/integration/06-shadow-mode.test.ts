import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { POST as chatPost } from "@/app/api/chat/route";
import {
  createMaxSession,
  handleMaxUpdate,
  type AgentOutcome,
  type MaxClient,
  type MaxUpdate,
  type ShadowQueueRecord,
} from "@/channels/max";
import { setModelClient } from "@/core/model";
import { closePool } from "@/db/pool";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

/**
 * Интеграционный тест среза 06 «Режим тени в веб-чате и MAX».
 *
 * Проверяется сквозной сценарий: одна настройка `tenants.shadow_mode` для
 * обоих каналов, подавление исходящих сообщений и очередь менеджера.
 *
 * Исходящая доставка MAX считается отдельным счётчиком: отсутствие
 * `POST /messages` доказывается счётчиком вызовов, а не отсутствием
 * видимого текста.
 */

const TENANT_SLUG = "test-integration-06";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

let tenantId = "";

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Заглушка модели: классификатор отвечает кодом класса, генератор — текстом
 * ответа со ссылкой на источник.
 */
function okModel(text: string, citations: string[] = []): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
} {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      const isClassification = request.messages.some((message) =>
        message.content.includes("класс обращения"),
      );
      if (isClassification) {
        return {
          text: "howto",
          amounts: [],
          citations: [],
          tokensIn: 10,
          tokensOut: 2,
          costRub: 0.1,
          model: "stub-model",
        };
      }
      return {
        text,
        amounts: [],
        citations,
        tokensIn: 10,
        tokensOut: 20,
        costRub: 0.1,
        model: "stub-model",
      };
    },
  };
}

function embeddingFor(words: string[]): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const word of words) {
    const stem = word.toLowerCase().slice(0, 6);
    let hash = 2166136261;
    for (let index = 0; index < stem.length; index += 1) {
      hash ^= stem.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % 1536;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  return vector;
}

async function seedArticle(): Promise<void> {
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

/** Заглушка Bot API MAX: считает вызовы `POST /messages`. */
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

function maxUpdate(mid: string, chatId: number, text = "вопрос"): MaxUpdate {
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
  answer: { text: "Подтверждённый ответ ядра", sources: [] },
  escalation: null,
  steps: [],
};

describe("интеграция режима тени в веб-чате и MAX", () => {
  beforeAll(async () => {
    process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-key";
    process.env.TENANT_SLUG = TENANT_SLUG;
    process.env.ESCALATION_MODE = "on";
    await ensureSchema();
  });

  beforeEach(async () => {
    await seedArticle();
    setModelClient(okModel(ARTICLE_TEXT, [ARTICLE_TEXT]));
  });

  afterEach(async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);
  });

  afterAll(async () => {
    await closePool();
  });

  it("одна настройка подавляет ответы обоих каналов и пишет очередь менеджера", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);

    // 1. Веб-чат: клиент ответа не получает, запись очереди создаётся.
    const webConversation = "9a1b2c3d-1111-4111-8111-111111111111";
    const webResponse = await chatPost(
      chatRequest({
        conversation_id: webConversation,
        message: {
          client_message_id: "9a1b2c3d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(webResponse.status).toBe(200);
    const webBody = (await webResponse.json()) as {
      outcome: string;
      answer: { text: string } | null;
    };
    expect(webBody.outcome).toBe("escalate");
    expect(webBody.answer).toBeNull();

    const webAgentMessages = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE tenant_id = $1 AND role = 'agent'",
      [tenantId],
    );
    expect(Number(webAgentMessages.rows[0]?.count ?? "0")).toBe(0);

    // 2. MAX: `POST /messages` не вызывается, запись очереди создаётся.
    const client = stubClient();
    const queued: ShadowQueueRecord[] = [];
    const session = await createMaxSession({
      token: "INTEGRATION-MAX-TOKEN-xyz789",
      client,
      runAgent: async () => respondOutcome,
      shadowMode: async () => {
        const row = await testPool().query<{ shadow_mode: boolean }>(
          "SELECT shadow_mode FROM tenants WHERE id = $1",
          [tenantId],
        );
        return Boolean(row.rows[0]?.shadow_mode);
      },
      recordShadowDraft: async (record) => {
        queued.push(record);
        return "queue-id-max";
      },
    });

    await handleMaxUpdate(session, maxUpdate("mid-shadow-1", 4242));

    // Счётчик исходящей доставки: вызова `POST /messages` не было.
    expect(client.sent).toHaveLength(0);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.channel).toBe("max");

    // 3. Обе записи очереди содержат диалог, причину, результат и трассу.
    const queue = await testPool().query<{
      channel: string;
      conversation_id: string;
      reason: string;
      result: string;
      trace_ref: string;
    }>("SELECT * FROM escalations WHERE tenant_id = $1 ORDER BY channel", [tenantId]);

    expect(queue.rows).toHaveLength(1);
    const webRecord = queue.rows[0];
    expect(webRecord?.channel).toBe("web");
    expect(webRecord?.conversation_id).toBe(webConversation);
    expect(webRecord?.reason).toBe("shadow_mode");
    expect(webRecord?.result).toContain("120 минут");
    expect(webRecord?.trace_ref).toBe(webConversation);
  });

  it("после отключения следующая обработка отвечает, а прежняя запись очереди остаётся", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = true WHERE id = $1", [tenantId]);

    const shadowConversation = "aa1b2c3d-1111-4111-8111-111111111111";
    await chatPost(
      chatRequest({
        conversation_id: shadowConversation,
        message: {
          client_message_id: "aa1b2c3d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    // Отключение режима действует только на новую обработку.
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);

    const webResponse = await chatPost(
      chatRequest({
        conversation_id: "aa1b2c3d-3333-4333-8333-333333333333",
        message: {
          client_message_id: "aa1b2c3d-4444-4444-8444-444444444444",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const webBody = (await webResponse.json()) as {
      outcome: string;
      answer: { text: string } | null;
    };
    expect(webBody.outcome).toBe("respond");
    expect(webBody.answer?.text).toContain("120 минут");

    const client = stubClient();
    const session = await createMaxSession({
      token: "INTEGRATION-MAX-TOKEN-xyz789",
      client,
      runAgent: async () => respondOutcome,
      shadowMode: async () => {
        const row = await testPool().query<{ shadow_mode: boolean }>(
          "SELECT shadow_mode FROM tenants WHERE id = $1",
          [tenantId],
        );
        return Boolean(row.rows[0]?.shadow_mode);
      },
    });

    await handleMaxUpdate(session, maxUpdate("mid-after-off", 4242));

    // Ответ ушёл ровно один раз.
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toBe("Подтверждённый ответ ядра");

    // Прежняя запись очереди осталась открытой.
    const queue = await testPool().query<{ status: string; result: string }>(
      "SELECT status, result FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]?.status).toBe("open");
    expect(queue.rows[0]?.result).toContain("120 минут");
  });

  it("эскалация не приводит к отправке даже при выключенном режиме тени", async () => {
    await testPool().query("UPDATE tenants SET shadow_mode = false WHERE id = $1", [tenantId]);

    // Модель отвечает без подтверждённого источника: результат — эскалация.
    setModelClient(okModel("Ответ из памяти модели: скидка 40 процентов."));

    const client = stubClient();
    const session = await createMaxSession({
      token: "INTEGRATION-MAX-TOKEN-xyz789",
      client,
      runAgent: async () => ({
        outcome: "escalate",
        answer: null,
        escalation: {
          id: "esc-1",
          reason: "no_confirmed_source",
          summary: "нет подтверждённого источника",
          draft: null,
        },
        steps: [],
      }),
      shadowMode: async () => {
        const row = await testPool().query<{ shadow_mode: boolean }>(
          "SELECT shadow_mode FROM tenants WHERE id = $1",
          [tenantId],
        );
        return Boolean(row.rows[0]?.shadow_mode);
      },
    });

    await handleMaxUpdate(session, maxUpdate("mid-escalate", 4242));

    // Эскалация не превращается в отправленный ответ.
    expect(client.sent).toHaveLength(0);
  });
});
