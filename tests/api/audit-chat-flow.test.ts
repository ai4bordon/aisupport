import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { POST } from "@/app/api/chat/route";
import { setModelClient } from "@/core/model";
import { setEmbeddingProvider } from "@/modules/knowledge";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

/**
 * Исправления веб-чата по отчёту BUGSAUDIT-2026-11-27.
 *
 * Закрываются находки:
 * - A1 — виджет генерирует новый `conversation_id` на каждом ходу;
 * - B1 — повтор `client_message_id` возвращает последний ответ диалога;
 * - B2 — ключ идемпотентности не содержит `conversation_id`;
 * - B3 — без cookie сервер принимает `conversation_id` из тела;
 * - B11 — веб-чат не читает таблицу соответствий меток;
 * - C2 — в `messages.text_original` хранится сырой текст клиента;
 * - C3 — две реализации таблицы соответствий масок;
 * - C4 — гонка при создании диалога: проверка владельца и вставка не атомарны;
 * - C5 — нет транзакции на ход;
 * - C20 — cookie диалога без срока жизни, битый percent-encoding роняет запрос.
 */

const TENANT_SLUG = "test-audit-chat-flow";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

let tenantId = "";

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
  outcome: string;
  answer: { text: string; sources: unknown[] } | null;
  escalation: { id: string; reason: string; summary: string } | null;
  trace: { steps: number; tokens: number; cost_rub: number };
};

/**
 * Заглушка модели: классификатор отвечает кодом класса, генератор — текстом
 * ответа. Текст ответа задаётся на каждый вызов: так проверяется, что
 * повтор хода возвращает ответ именно своего сообщения.
 *
 * Счётчик генераций отдаётся наружу: по нему видно, что повтор не обращался
 * к модели заново.
 */
function scriptedModel(texts: string[]): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
  generationCount: () => number;
} {
  let generation = 0;
  return {
    generationCount: () => generation,
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
      const text = texts[generation] ?? texts[texts.length - 1] ?? ARTICLE_TEXT;
      generation += 1;
      return {
        text,
        amounts: [],
        citations: [ARTICLE_TEXT],
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

describe("POST /v1/chat — исправления по отчёту аудита", () => {
  beforeAll(async () => {
    process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-key";
    process.env.TENANT_SLUG = TENANT_SLUG;
    await ensureSchema();
    setEmbeddingProvider({
      model: "deterministic-hash-v1",
      embed: async (text: string): Promise<number[]> =>
        embeddingFor(text.split(/\s+/).slice(0, 3)),
    });
  });

  beforeEach(async () => {
    process.env.ESCALATION_MODE = "on";
    await seedArticle();
    setModelClient(scriptedModel([ARTICLE_TEXT]));
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * B3: без подписанной cookie значение `conversation_id` из тела запроса
   * диалог не определяет. Чужой диалог по UUID из тела недоступен.
   */
  it("без cookie чужой conversation_id из тела не продолжает чужой диалог", async () => {
    const foreignConversationId = "1a2b3c4d-1111-4111-8111-111111111111";
    const foreignMessageId = "1a2b3c4d-2222-4222-8222-222222222222";

    // Чужой диалог создаётся подписанной cookie другого клиента.
    const owner = await POST(
      chatRequest({
        conversation_id: foreignConversationId,
        message: {
          client_message_id: foreignMessageId,
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const ownerCookie = (owner.headers.get("set-cookie") ?? "").split(";")[0];
    expect(ownerCookie).toContain("support_conversation=");

    // Запрос без cookie с тем же `conversation_id` и тем же
    // `client_message_id` не должен вернуть ответ чужого диалога.
    const response = await POST(
      chatRequest({
        conversation_id: foreignConversationId,
        message: {
          client_message_id: foreignMessageId,
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    // Диалог новый: идентификатор не совпадает с чужим.
    expect(body.conversation_id).not.toBe(foreignConversationId);

    // В чужом диалоге появился ровно один ход клиента — тот, что сделал
    // его владелец.
    const foreign = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND role = 'client'",
      [foreignConversationId],
    );
    expect(Number(foreign.rows[0]?.count ?? "0")).toBe(1);
  });
  /**
   * B2: тот же `client_message_id` в другом диалоге не подхватывает ответ
   * первого диалога.
   */
  it("тот же client_message_id в другом диалоге даёт отдельный ход", async () => {
    const sharedMessageId = "2a2b3c4d-2222-4222-8222-222222222222";

    const first = await POST(
      chatRequest({
        conversation_id: "2a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: sharedMessageId,
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const firstBody = (await first.json()) as ChatBody;

    const second = await POST(
      chatRequest({
        conversation_id: "2a2b3c4d-3333-4333-8333-333333333333",
        message: {
          client_message_id: sharedMessageId,
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const secondBody = (await second.json()) as ChatBody;

    expect(secondBody.conversation_id).not.toBe(firstBody.conversation_id);

    // Оба хода сохранены: сообщение второго диалога не потеряно.
    const messages = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE tenant_id = $1 AND role = 'client'",
      [tenantId],
    );
    expect(Number(messages.rows[0]?.count ?? "0")).toBe(2);
  });

  /**
   * B1: повтор того же `client_message_id` возвращает ответ именно этого
   * сообщения, а не последний ответ диалога.
   */
  it("повтор client_message_id возвращает ответ именно этого сообщения", async () => {
    const model = scriptedModel([
      "Первый ответ: лицензия в течение 120 минут.",
      "Второй ответ: КП готовится в течение 120 минут.",
    ]);
    setModelClient(model);

    const conversationId = "3a2b3c4d-1111-4111-8111-111111111111";
    const firstMessageId = "3a2b3c4d-2222-4222-8222-222222222222";
    const secondMessageId = "3a2b3c4d-3333-4333-8333-333333333333";

    const first = await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: firstMessageId,
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const firstBody = (await first.json()) as ChatBody;
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    const second = await POST(
      chatRequest(
        {
          conversation_id: conversationId,
          message: {
            client_message_id: secondMessageId,
            text: "Как получить электронную лицензию? А какой срок?",
          },
        },
        cookie,
      ),
    );
    const secondBody = (await second.json()) as ChatBody;
    expect(secondBody.answer?.text).toContain("Второй ответ");

    // Повтор первого сообщения возвращает первый ответ, а не второй.
    const repeated = await POST(
      chatRequest(
        {
          conversation_id: conversationId,
          message: {
            client_message_id: firstMessageId,
            text: "Как получить электронную лицензию?",
          },
        },
        cookie,
      ),
    );
    const repeatedBody = (await repeated.json()) as ChatBody;

    expect(repeatedBody.outcome).toBe("respond");
    expect(repeatedBody.answer?.text).toContain("Первый ответ");
    expect(repeatedBody.answer?.text).not.toContain("Второй ответ");
    expect(repeatedBody.message_id).toBe(firstBody.message_id);

    // Повтор не обращался к модели заново: генерация была ровно два раза —
    // по одному на каждое сообщение.
    expect(model.generationCount()).toBe(2);
  });

  /**
   * B11: веб-чат читает таблицу соответствий меток диалога. Метка второго
   * хода восстанавливается в исходное значение, а не остаётся меткой.
   */
  it("метка второго хода восстанавливается по таблице соответствий диалога", async () => {
    const conversationId = "4a2b3c4d-1111-4111-8111-111111111111";
    const email = "client@example.com";

    const first = await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: "4a2b3c4d-2222-4222-8222-222222222222",
          text: `Моя почта ${email}. Как получить электронную лицензию?`,
        },
      }),
    );
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    expect(first.status).toBe(200);

    // Модель во втором ходе возвращает метку — она уже известна диалогу.
    setModelClient(scriptedModel([`Ответ на почту ⟦EMAIL_1⟧`]));

    const second = await POST(
      chatRequest(
        {
          conversation_id: conversationId,
          message: {
            client_message_id: "4a2b3c4d-3333-4333-8333-333333333333",
            text: "Как получить электронную лицензию? Напомните про мою почту",
          },
        },
        cookie,
      ),
    );
    const secondBody = (await second.json()) as ChatBody;

    expect(secondBody.outcome).toBe("respond");
    // Метка восстановлена в исходное значение.
    expect(secondBody.answer?.text).toContain(email);
    expect(secondBody.answer?.text).not.toContain("⟦EMAIL_1⟧");

    // В таблице соответствий диалога значение лежит один раз.
    const mask = await testPool().query<{ label: string; value: string }>(
      "SELECT label, value FROM conversation_mask WHERE conversation_id = $1",
      [conversationId],
    );
    expect(mask.rows).toHaveLength(1);
    expect(mask.rows[0]?.label).toBe("⟦EMAIL_1⟧");
    expect(mask.rows[0]?.value).toBe(email);
  });

  /**
   * C2 и C3: сырой текст клиента не хранится в `messages.text_original`,
   * исходные значения лежат только в таблице соответствий.
   */
  it("messages.text_original не содержит сырого текста клиента", async () => {
    const conversationId = "5a2b3c4d-1111-4111-8111-111111111111";
    const phone = "+7 (495) 123-45-67";

    await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: "5a2b3c4d-2222-4222-8222-222222222222",
          text: `Мой телефон ${phone}. Как получить электронную лицензию?`,
        },
      }),
    );

    const messages = await testPool().query<{
      text_masked: string;
      text_original: string | null;
    }>(
      `SELECT text_masked, text_original FROM messages
        WHERE conversation_id = $1 AND role = 'client'`,
      [conversationId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]?.text_original ?? "").not.toContain(phone);
    expect(messages.rows[0]?.text_original ?? "").toBe("");
    // Замаскированный текст метку содержит.
    expect(messages.rows[0]?.text_masked).toContain("⟦");

    // Исходное значение лежит в таблице соответствий диалога.
    const mask = await testPool().query<{ value: string }>(
      "SELECT value FROM conversation_mask WHERE conversation_id = $1",
      [conversationId],
    );
    expect(mask.rows.map((row) => row.value)).toContain(phone);
  });

  /**
   * C4: проверка владельца и вставка атомарны. Диалог, занятый другим
   * арендатором, не принимается.
   */
  it("диалог другого арендатора недоступен", async () => {
    // Арендатор-чужой создаётся заново: предыдущий прогон мог оставить его
    // в базе. Сначала удаляются его диалоги — на них ссылается внешний ключ.
    await testPool().query(
      "DELETE FROM conversations WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = $1)",
      ["test-audit-chat-flow-other"],
    );
    await testPool().query("DELETE FROM tenants WHERE slug = $1", [
      "test-audit-chat-flow-other",
    ]);
    const foreignTenant = await testPool().query<{ id: string }>(
      "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
      ["test-audit-chat-flow-other", "Другой арендатор"],
    );
    const foreignTenantId = foreignTenant.rows[0]?.id ?? "";
    const conversationId = "6a2b3c4d-1111-4111-8111-111111111111";

    await testPool().query(
      `INSERT INTO conversations (id, tenant_id, channel, status)
       VALUES ($1, $2, 'web', 'open')`,
      [conversationId, foreignTenantId],
    );

    const response = await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: "6a2b3c4d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    // Диалог чужого арендатора не продолжается: создан новый.
    expect(body.conversation_id).not.toBe(conversationId);

    const foreign = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1",
      [conversationId],
    );
    expect(Number(foreign.rows[0]?.count ?? "0")).toBe(0);

    await testPool().query("DELETE FROM conversations WHERE id = $1", [
      conversationId,
    ]);
    await testPool().query("DELETE FROM tenants WHERE id = $1", [foreignTenantId]);
  });

  /**
   * C5: ход записывается целиком. Сообщение клиента и ответ агента лежат в
   * одной транзакции: у клиентского сообщения всегда есть ответ.
   */
  it("ход записывается целиком: у сообщения клиента есть ответ", async () => {
    const conversationId = "7a2b3c4d-1111-4111-8111-111111111111";

    const response = await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: "7a2b3c4d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    expect(response.status).toBe(200);

    const messages = await testPool().query<{ role: string }>(
      "SELECT role FROM messages WHERE conversation_id = $1 ORDER BY created_at",
      [conversationId],
    );
    const roles = messages.rows.map((row) => row.role);
    expect(roles).toEqual(["client", "agent"]);

    // Идентификатор ответа совпадает с тем, что вернул маршрут.
    const body = (await response.json()) as ChatBody;
    const reply = await testPool().query<{ id: string }>(
      "SELECT id FROM messages WHERE conversation_id = $1 AND role = 'agent'",
      [conversationId],
    );
    expect(reply.rows[0]?.id).toBe(body.message_id);
  });

  /**
   * C20: битый percent-encoding в cookie не роняет запрос — cookie считается
   * отсутствующей, и клиент получает новый диалог.
   */
  it("битый percent-encoding в cookie даёт новый диалог, а не 500", async () => {
    const response = await POST(
      chatRequest(
        {
          conversation_id: "8a2b3c4d-1111-4111-8111-111111111111",
          message: {
            client_message_id: "8a2b3c4d-2222-4222-8222-222222222222",
            text: "Как получить электронную лицензию?",
          },
        },
        "support_conversation=%E0%A4%A",
      ),
    );

    // Запрос не упал: повреждённая cookie равна отсутствующей.
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("support_conversation=");

    const body = (await response.json()) as ChatBody;
    const messages = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND role = 'client'",
      [body.conversation_id],
    );
    expect(Number(messages.rows[0]?.count ?? "0")).toBe(1);
  });

  /**
   * C20: cookie диалога живёт семь суток.
   */
  it("cookie диалога имеет срок жизни", async () => {
    const response = await POST(
      chatRequest({
        conversation_id: "9a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "9a2b3c4d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  /**
   * A1: два хода подряд в одном диалоге идут по одному идентификатору.
   * Именно это делает виджет: идентификатор из ответа сервера.
   */
  it("два хода подряд с идентификатором из ответа идут в одном диалоге", async () => {
    const first = await POST(
      chatRequest({
        conversation_id: "aa2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "aa2b3c4d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const firstBody = (await first.json()) as ChatBody;
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    expect(first.status).toBe(200);

    // Второй ход идёт с идентификатором, который вернул сервер.
    const second = await POST(
      chatRequest(
        {
          conversation_id: firstBody.conversation_id,
          message: {
            client_message_id: "aa2b3c4d-3333-4333-8333-333333333333",
            text: "Как получить электронную лицензию? А какой срок?",
          },
        },
        cookie,
      ),
    );
    const secondBody = (await second.json()) as ChatBody;

    expect(second.status).toBe(200);
    expect(secondBody.conversation_id).toBe(firstBody.conversation_id);
    expect(secondBody.outcome).toBe("respond");

    const conversations = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM conversations WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(conversations.rows[0]?.count ?? "0")).toBe(1);
  });
});
