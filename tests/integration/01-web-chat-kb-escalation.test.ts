import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { POST } from "@/app/api/chat/route";
import { setModelClient } from "@/core/model";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

/**
 * Интеграционная проверка вертикального среза «веб-чат → ответ из БЗ →
 * эскалация» по критериям приёмки тикета 01.
 *
 * Команда проверки: npm run test -- tests/integration/01-web-chat-kb-escalation.test.ts
 *
 * Модель подменяется на границе: реальных ключей у среза нет.
 */
const TENANT_SLUG = "test-integration-01";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";
const SOURCE_URL = "https://docs.softline.com/ru-ru/licensing";

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
    const index = Math.abs(hash) % 1536;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  return vector;
}

function stubModel(text: string, citations: string[] = []): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
} {
  return {
    complete: async (): Promise<ModelResult> => ({
      text,
      amounts: [],
      citations,
      tokensIn: 42,
      tokensOut: 24,
      costRub: 0.25,
      model: "stub-model",
    }),
  };
}

async function seedKnowledge(): Promise<void> {
  tenantId = await resetTenant(TENANT_SLUG);

  const article = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Лицензирование', $2, 'published', now(), now())
     RETURNING id`,
    [tenantId, ARTICLE_TEXT],
  );

  // Шапка чанка несёт ссылку на источник — так ссылка попадает в ответ.
  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $4), $5::vector, 'deterministic-hash-v1')`,
    [
      tenantId,
      article.rows[0]?.id ?? "",
      `Источник: ${SOURCE_URL}\n${ARTICLE_TEXT}`,
      ARTICLE_TEXT,
      `[${embeddingFor(["Электронная", "лицензия", "предоставляется"]).join(",")}]`,
    ],
  );

  // Неодобренные материалы: в выдачу попадать не должны.
  const draft = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from)
     VALUES ($1, 'Постоплата', 'Отсрочка платежа предоставляется по письменному согласованию.', 'draft', now())
     RETURNING id`,
    [tenantId],
  );
  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [
      tenantId,
      draft.rows[0]?.id ?? "",
      "Отсрочка платежа предоставляется по письменному согласованию.",
      `[${embeddingFor(["Отсрочка", "платежа", "предоставляется"]).join(",")}]`,
    ],
  );

  const pending = await testPool().query<{ id: string }>(
    `INSERT INTO kb_documents (tenant_id, filename, mime_type, size_bytes, storage_path, status)
     VALUES ($1, 'pending.pdf', 'application/pdf', 100, '/tmp/pending.pdf', 'pending')
     RETURNING id`,
    [tenantId],
  );
  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, document_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [
      tenantId,
      pending.rows[0]?.id ?? "",
      "Материал загруженного документа ждёт одобрения менеджера.",
      `[${embeddingFor(["Материал", "загруженного", "документа"]).join(",")}]`,
    ],
  );
}

function chatRequest(body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

type ChatBody = {
  conversation_id: string;
  message_id: string;
  outcome: "respond" | "escalate";
  answer: {
    text: string;
    sources: Array<{ kind: string; id: string; title: string; location: string | null }>;
  } | null;
  escalation: { id: string; reason: string; summary: string; draft: string | null } | null;
  trace: { steps: number; tokens: number; cost_rub: number };
};

describe("интеграционная проверка среза 01", () => {
  beforeAll(async () => {
    process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-key";
    process.env.TENANT_SLUG = TENANT_SLUG;
    await ensureSchema();
  });

  beforeEach(async () => {
    // Режим эскалации задаётся в каждом тесте явно: тесты меняют его, а
    // порядок выполнения не должен влиять на результат.
    process.env.ESCALATION_MODE = "on";
    await seedKnowledge();
  });

  afterAll(async () => {
    await closePool();
  });

  it("AC1: вопрос по опубликованной статье получает ответ со ссылкой на источник", async () => {
    setModelClient(stubModel(ARTICLE_TEXT, [ARTICLE_TEXT]));

    const response = await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "0a1b2c3d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    expect(body.outcome).toBe("respond");
    expect(body.answer?.text).toContain("120 минут");
    expect(body.answer?.sources.length).toBeGreaterThan(0);
    expect(body.answer?.sources[0]?.title).toBe("Лицензирование");
    expect(body.answer?.sources[0]?.location).toContain("docs.softline.com");
    expect(body.escalation).toBeNull();
  });

  it("AC2: вопрос без опубликованного источника создаёт эскалацию и не выдаёт неподтверждённый факт", async () => {
    // Режим `on`: без подтверждённого источника — эскалация (ADR-0014).
    process.env.ESCALATION_MODE = "on";
    setModelClient(stubModel("Ответ из памяти модели: скидка 40 процентов."));

    const response = await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "0a1b2c3d-3333-4333-8333-333333333333",
          text: "Как настроить квантовый телепорт?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();
    expect(body.escalation?.reason).toBe("no_confirmed_source");
    expect(body.escalation?.summary).toBeTruthy();

    const escalation = await testPool().query<{
      reason: string;
      summary: string;
      conversation_id: string;
    }>(
      "SELECT reason, summary, conversation_id FROM escalations WHERE tenant_id = $1",
      [tenantId],
    );
    expect(escalation.rows).toHaveLength(1);
    expect(escalation.rows[0]?.reason).toBe("no_confirmed_source");
    expect(escalation.rows[0]?.conversation_id).toBe(
      "0a1b2c3d-1111-4111-8111-111111111111",
    );

    const steps = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_steps WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(steps.rows[0]?.count ?? "0")).toBeGreaterThan(0);
  });

  it("AC3: подписанная cookie продолжает диалог, отсутствие cookie создаёт новый, одинаковый IP не объединяет", async () => {
    setModelClient(stubModel(ARTICLE_TEXT, [ARTICLE_TEXT]));

    const first = await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "0a1b2c3d-4444-4444-8444-444444444444",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("support_conversation=");

    const continued = await POST(
      chatRequest(
        {
          conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
          message: {
            client_message_id: "0a1b2c3d-5555-4555-8555-555555555555",
            text: "Как получить электронную лицензию?",
          },
        },
        cookie,
      ),
    );
    const continuedBody = (await continued.json()) as ChatBody;
    expect(continuedBody.conversation_id).toBe("0a1b2c3d-1111-4111-8111-111111111111");

    // Два клиента без cookie получают разные диалоги: идентификация по IP
    // не используется, а тело запроса не может подменить чужой диалог.
    const other = await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-6666-4666-8666-666666666666",
        message: {
          client_message_id: "0a1b2c3d-7777-4777-8777-777777777777",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const otherBody = (await other.json()) as ChatBody;
    expect(otherBody.conversation_id).not.toBe(
      "0a1b2c3d-1111-4111-8111-111111111111",
    );

    const conversations = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM conversations WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(conversations.rows[0]?.count ?? "0")).toBe(2);
  });

  it("AC4: ПД доходят до границы модели только метками, исходящая проверка отклоняет сырые ПД", async () => {
    const seen: string[] = [];
    setModelClient({
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        seen.push(request.messages.map((message) => message.content).join(" "));
        return {
          text: ARTICLE_TEXT,
          amounts: [],
          citations: [ARTICLE_TEXT],
          tokensIn: 10,
          tokensOut: 10,
          costRub: 0,
          model: "stub-model",
        };
      },
    });

    const response = await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "0a1b2c3d-8888-4888-8888-888888888888",
          text: "Иванов Иван Иванович из ООО «Ромашка», адрес: ул. Ленина, д. 5, телефон +7 (495) 123-45-67, email ivanov@example.com, ИНН 7707083893, расчётный счёт 40702810100000012345, паспорт 45 08 123456. Как получить электронную лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const modelInput = seen.join(" ");
    expect(modelInput).toContain("⟦");
    for (const secret of [
      "Иванов",
      "Ромашка",
      "Ленина",
      "ivanov@example.com",
      "7707083893",
      "40702810100000012345",
      "123456",
    ]) {
      expect(modelInput, `в запрос к модели попало ${secret}`).not.toContain(secret);
    }

    // Таблица соответствий остаётся в серверной части.
    const messages = await testPool().query<{ text_masked: string; text_original: string }>(
      "SELECT text_masked, text_original FROM messages WHERE tenant_id = $1 AND role = 'client'",
      [tenantId],
    );
    expect(messages.rows[0]?.text_masked).toContain("⟦");
    expect(messages.rows[0]?.text_masked).not.toContain("Иванов");

    // Исходящая проверка отклоняет сырые ПД в ответе.
    setModelClient(stubModel("Иван из ООО «Ромашка» получит лицензию."));
    const leaking = await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "0a1b2c3d-9999-4999-8999-999999999999",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(leaking.status).toBe(422);
  });

  it("AC5: трасса содержит упорядоченные операции, source_ids, outcome, длительность и usage без учётных данных", async () => {
    setModelClient(stubModel(ARTICLE_TEXT, [ARTICLE_TEXT]));

    await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "0a1b2c3d-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    const steps = await testPool().query<{
      node: string;
      endpoint: string | null;
      source_ids: string[];
      outcome: string | null;
      latency_ms: number;
      tokens_in: number;
      tokens_out: number;
      model: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT node, endpoint, source_ids, outcome, latency_ms, tokens_in, tokens_out, model, metadata
       FROM agent_steps WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );

    const nodes = steps.rows.map((row) => row.node);
    expect(nodes).toContain("classify");
    expect(nodes).toContain("retrieve");
    expect(nodes).toContain("validate");
    expect(nodes.at(-1)).toBe("respond");

    const retrieve = steps.rows.find((row) => row.node === "retrieve");
    expect(retrieve?.source_ids.length).toBeGreaterThan(0);

    // Итоговый узел respond несёт outcome; шаг генерации — с outcome=null.
    const respond = steps.rows.findLast((row) => row.node === "respond");
    expect(respond?.outcome).toBe("respond");
    expect(respond?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(respond?.model).toBeTruthy();

    // Учётных данных в трассе нет.
    const serialized = JSON.stringify(steps.rows);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("session_secret");
  });

  it("AC6: неодобренные материалы не попадают в поиск и в ответ", async () => {
    setModelClient(stubModel(ARTICLE_TEXT, [ARTICLE_TEXT]));

    const response = await POST(
      chatRequest({
        conversation_id: "0a1b2c3d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "0a1b2c3d-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          text: "Отсрочка платежа и материаль загруженного документа",
        },
      }),
    );

    const body = (await response.json()) as ChatBody;
    const serialized = JSON.stringify(body);
    // Проверяется материал, а не совпадение слов: «Отсрочка платежа» —
    // и вопрос клиента, и формулировка правила полномочий. Уникальный
    // фрагмент неодобренного материала — «по письменному согласованию».
    expect(serialized).not.toContain("по письменному согласованию");
    expect(serialized).not.toContain("ждёт одобрения");
  });
});
