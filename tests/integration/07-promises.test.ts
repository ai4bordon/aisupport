import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { POST as chat } from "@/app/api/chat/route";
import { POST as agentRun } from "@/app/api/agent/run/route";
import { GET as promisesRoute } from "@/app/api/promises/route";
import { setModelClient } from "@/core/model";
import { deterministicEmbeddingProvider } from "@/modules/knowledge/search";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

/**
 * Интеграционная проверка среза 07 «Учёт утверждённых обещаний клиентам».
 *
 * Команда проверки: npm run test -- tests/integration/07-promises.test.ts
 *
 * Три ветки канала: веб-чат без адреса (обещания нет), веб-чат с адресом
 * (запись с адресатом) и MAX (запись в чат). Плюс отклонённый срок,
 * просрочка и отсутствие внешних отправок.
 *
 * Модель подменяется на границе: реальных ключей у среза нет.
 */
const TENANT_SLUG = "test-integration-07";

const CLIENT_QUESTION = "Сколько ждать коммерческое предложение?";

const ARTICLE_TEXT =
  "Срок подготовки коммерческого предложения — 120 минут после оплаты.";

const PROMISE_LINE =
  "ОБЕЩАНИЕ: Пришлю КП | срок: 120 минут | источник: [1]";

let tenantId = "";

/**
 * Вектор эмбеддинга для статьи.
 *
 * Используется детерминированный провайдер самого модуля базы знаний:
 * свой хеш дал бы вектор, не совпадающий с тем, которым индексированы
 * чанки, и поиск не нашёл бы статью.
 */
async function embed(text: string): Promise<number[]> {
  return deterministicEmbeddingProvider.embed(text);
}
/**
 * Заглушка модели: на запрос классификации отвечает кодом класса, на запрос
 * ответа — заданным текстом.
 */
function stubModel(text: string): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
} {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      const prompt = request.messages.map((message) => message.content).join(" ");
      if (prompt.includes("Ответь одним кодом")) {
        return {
          text: "howto",
          amounts: [],
          citations: [],
          tokensIn: 1,
          tokensOut: 1,
          costRub: 0,
          model: "stub",
        };
      }
      return {
        text,
        amounts: [],
        citations: [ARTICLE_TEXT],
        tokensIn: 1,
        tokensOut: 1,
        costRub: 0,
        model: "stub",
      };
    },
  };
}

async function seedKnowledge(): Promise<void> {
  tenantId = await resetTenant(TENANT_SLUG);

  const article = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Коммерческое предложение', $2, 'published', now(), now())
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
      `[${(await embed(ARTICLE_TEXT)).join(",")}]`,
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

function agentRequest(body: unknown): Request {
  return new Request("http://localhost/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type ChatBody = {
  conversation_id: string;
  outcome: "respond" | "escalate";
  answer: { text: string } | null;
  escalation: { id: string; reason: string; summary: string } | null;
};

describe("интеграционная проверка среза 07", () => {
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

  it("AC1: подтверждённый срок даёт запись обещания с диалогом, сроком и ответственным", async () => {
    // Канал MAX: адресат — диалог, адрес клиента не требуется (ADR-0018).
    // В веб-канале то же обещание без адреса не создаётся — это отдельный
    // случай AC6.
    setModelClient(stubModel(`${ARTICLE_TEXT}\n${PROMISE_LINE}`));

    const response = await agentRun(
      agentRequest({
        conversation_id: "1a1b2c3d-1111-4111-8111-111111111111",
        message_id: "1a1b2c3d-2222-4222-8222-222222222222",
        channel: "max",
        external_chat_id: "chat-1001",
        text: CLIENT_QUESTION,
        masked_fields_count: 0,
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      answer: { text: string } | null;
    };
    expect(body.outcome).toBe("respond");

    const promises = await testPool().query<{
      conversation_id: string;
      text: string;
      due_at: Date;
      owner: string;
      status: string;
      source_kind: string | null;
      source_id: string | null;
      channel: string;
    }>(
      `SELECT conversation_id, text, due_at, owner, status, source_kind, source_id, channel
         FROM promises WHERE tenant_id = $1`,
      [tenantId],
    );

    expect(promises.rows).toHaveLength(1);
    const record = promises.rows[0];
    expect(record?.conversation_id).toBe("1a1b2c3d-1111-4111-8111-111111111111");
    expect(record?.owner).toBe("manager");
    expect(record?.status).toBe("open");
    expect(record?.source_kind).toBe("kb_article");
    expect(record?.source_id).toBeTruthy();
    expect(record?.due_at.getTime()).toBeGreaterThan(Date.now());

    // Клиентский ответ содержит то же обещание, что и запись в журнале.
    expect(body.answer?.text).toContain(record?.text);
  });

  it("AC2: срок, которого нет в источнике, ведёт к эскалации без обещания", async () => {
    setModelClient(
      stubModel("ОБЕЩАНИЕ: Пришлю КП | срок: 15 минут | источник: [1]"),
    );

    const response = await chat(
      chatRequest({
        conversation_id: "2a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "2a1b2c3d-2222-4222-8222-222222222222",
          text: CLIENT_QUESTION,
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();

    const promises = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM promises WHERE tenant_id = $1",
      [tenantId],
    );
    expect(promises.rows[0]?.count).toBe("0");

    const escalations = await testPool().query<{ reason: string }>(
      "SELECT reason FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );
    expect(escalations.rows.length).toBeGreaterThan(0);
    expect(escalations.rows.map((row) => row.reason)).toContain("no_confirmed_source");
  });

  it("AC3: журнал перечисляет открытые, выполненные и просроченные обещания", async () => {
    const conversation = await testPool().query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, channel, status)
       VALUES ($1, 'web', 'open') RETURNING id`,
      [tenantId],
    );
    const conversationId = conversation.rows[0]?.id ?? "";

    await testPool().query(
      `INSERT INTO promises
         (tenant_id, conversation_id, text, due_at, owner, status, channel, is_synthetic)
       VALUES
         ($1, $2, 'Открытое обещание', now() + interval '10 days', 'manager', 'open', 'max', false),
         ($1, $2, 'Выполненное обещание', now() + interval '10 days', 'manager', 'done', 'max', false),
         ($1, $2, 'Просроченное обещание', now() - interval '1 day', 'manager', 'open', 'max', true)`,
      [tenantId, conversationId],
    );

    const response = await promisesRoute(
      new Request("http://localhost/api/promises"),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      promises: Array<{
        status: string;
        origin: string;
        overdue: boolean;
        channel: string;
        contact: string | null;
      }>;
    };

    const statuses = body.promises.map((item) => item.status);
    expect(statuses).toContain("open");
    expect(statuses).toContain("done");
    expect(statuses).toContain("overdue");

    const synthetic = body.promises.find(
      (item) => item.origin === "синтетический/демонстрационный",
    );
    expect(synthetic).toBeDefined();
    expect(synthetic?.overdue).toBe(true);
  });

  it("AC4: внешних отправок нет, reminded_at остаётся пустым", async () => {
    setModelClient(stubModel(`${ARTICLE_TEXT}\n${PROMISE_LINE}`));

    await agentRun(
      agentRequest({
        conversation_id: "e4a1b2c3-1111-4111-8111-111111111111",
        message_id: "e4a1b2c3-2222-4222-8222-222222222222",
        channel: "max",
        external_chat_id: "chat-1004",
        text: CLIENT_QUESTION,
        masked_fields_count: 0,
      }),
    );

    const rows = await testPool().query<{ reminded_at: Date | null }>(
      "SELECT reminded_at FROM promises WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.reminded_at).toBeNull();
    }
  });

  it("AC6: веб-чат без адреса не создаёт обещание и спрашивает адрес", async () => {
    setModelClient(stubModel(`${ARTICLE_TEXT}\n${PROMISE_LINE}`));

    const response = await chat(
      chatRequest({
        conversation_id: "e5a1b2c3-1111-4111-8111-111111111111",
        message: {
          client_message_id: "e5a1b2c3-2222-4222-8222-222222222222",
          text: CLIENT_QUESTION,
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    expect(body.outcome).toBe("respond");
    expect(body.answer?.text).toContain("На какой адрес отправить КП?");
    expect(body.answer?.text).not.toContain("120 минут");

    const promises = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM promises WHERE tenant_id = $1",
      [tenantId],
    );
    expect(promises.rows[0]?.count).toBe("0");
  });

  it("AC6: веб-чат с адресом создаёт запись с каналом email и адресатом", async () => {
    setModelClient(stubModel(`${ARTICLE_TEXT}\n${PROMISE_LINE}`));

    const response = await chat(
      chatRequest({
        conversation_id: "e6a1b2c3-1111-4111-8111-111111111111",
        message: {
          client_message_id: "e6a1b2c3-2222-4222-8222-222222222222",
          text: `${CLIENT_QUESTION} Пришлите на client@example.com`,
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    expect(body.outcome).toBe("respond");

    const promises = await testPool().query<{
      channel: string;
      contact_email: string | null;
      contact_label: string | null;
      due_at: Date;
      owner: string;
    }>(
      `SELECT channel, contact_email, contact_label, due_at, owner
         FROM promises WHERE tenant_id = $1`,
      [tenantId],
    );

    expect(promises.rows).toHaveLength(1);
    expect(promises.rows[0]?.channel).toBe("email");
    expect(promises.rows[0]?.contact_email).toBe("client@example.com");
    expect(promises.rows[0]?.contact_label).toBe("⟦EMAIL_1⟧");
    expect(promises.rows[0]?.owner).toBe("manager");
    expect(promises.rows[0]?.due_at.getTime()).toBeGreaterThan(Date.now());

    // Ответ клиенту содержит обещание с адресом и сроком. Формулировку
    // обязательства сохраняет модель, а код добавляет адресата и срок
    // (ADR-0019, C18): раньше текст переписывался шаблоном кода.
    expect(body.answer?.text).toContain("Пришлю КП");
    expect(body.answer?.text).toContain("client@example.com");
    expect(body.answer?.text).toContain("120");
  });

  it("AC5: MAX создаёт запись с каналом max и адресатом-диалогом", async () => {
    setModelClient(stubModel(`${ARTICLE_TEXT}\n${PROMISE_LINE}`));

    const response = await agentRun(
      agentRequest({
        conversation_id: "e7a1b2c3-1111-4111-8111-111111111111",
        message_id: "e7a1b2c3-2222-4222-8222-222222222222",
        channel: "max",
        external_chat_id: "chat-4242",
        text: CLIENT_QUESTION,
        masked_fields_count: 0,
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      answer: { text: string } | null;
    };
    expect(body.outcome).toBe("respond");
    expect(body.answer?.text).toContain("Пришлю КП");
    expect(body.answer?.text).toContain("120");

    const promises = await testPool().query<{
      channel: string;
      external_chat_id: string | null;
      contact_email: string | null;
    }>(
      "SELECT channel, external_chat_id, contact_email FROM promises WHERE tenant_id = $1",
      [tenantId],
    );

    expect(promises.rows).toHaveLength(1);
    expect(promises.rows[0]?.channel).toBe("max");
    expect(promises.rows[0]?.external_chat_id).toBe("chat-4242");
    expect(promises.rows[0]?.contact_email).toBeNull();
  });

  it("AC7: адрес в трассе и в тексте обещания представлен меткой, значение — в таблице соответствий", async () => {
    setModelClient(stubModel(`${ARTICLE_TEXT}\n${PROMISE_LINE}`));

    await chat(
      chatRequest({
        // UUID диалога уникален для среза: общий с другим тестом диалог
        // принадлежал бы чужому арендатору, и веб-роут отклонил бы запрос
        // с 403 до записи обещания.
        conversation_id: "c7a1b2c3-1111-4111-8111-111111111111",
        message: {
          client_message_id: "c7a1b2c3-2222-4222-8222-222222222222",
          text: `${CLIENT_QUESTION} Пришлите на client@example.com`,
        },
      }),
    );

    // В записи обещания — метка, а не исходный адрес.
    const stored = await testPool().query<{ text: string; contact_label: string | null }>(
      "SELECT text, contact_label FROM promises WHERE tenant_id = $1",
      [tenantId],
    );
    expect(stored.rows[0]?.text).toContain("⟦EMAIL_1⟧");
    expect(stored.rows[0]?.text).not.toContain("client@example.com");

    // Исходное значение лежит в таблице соответствий диалога.
    const mask = await testPool().query<{ value: string }>(
      `SELECT value FROM conversation_mask
        WHERE conversation_id = 'c7a1b2c3-1111-4111-8111-111111111111'`,
    );
    expect(mask.rows[0]?.value).toBe("client@example.com");

    // В трассе адреса нет: только метка.
    const steps = await testPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM agent_steps
        WHERE conversation_id = 'c7a1b2c3-1111-4111-8111-111111111111'`,
    );
    const trace = JSON.stringify(steps.rows.map((row) => row.metadata));
    expect(trace).toContain("⟦EMAIL_1⟧");
    expect(trace).not.toContain("client@example.com");
  });
});
