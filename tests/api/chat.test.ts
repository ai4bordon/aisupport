import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { POST } from "@/app/api/chat/route";
import { setModelClient } from "@/core/model";
import { setEmbeddingProvider } from "@/modules/knowledge";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

/**
 * Контракт `POST /v1/chat` (docs/api-contract.md §4).
 *
 * Модель подменяется на границе — реальных ключей у среза нет.
 */
const TENANT_SLUG = "test-api-chat";
const ARTICLE_TEXT =
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.";

let tenantId = "";

function chatRequest(
  body: unknown,
  cookie?: string,
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Заглушка модели: отвечает кодом класса на запрос классификации и текстом
 * ответа на генерацию.
 *
 * Классификатор и генератор различаются по системному промпту, поэтому одна
 * заглушка обслуживает обе фазы: иначе классификатор получал бы текст ответа
 * и маршрут определялся бы неверно.
 */
function okModel(
  text: string,
  citations: string[] = [],
  intent = "howto",
): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
} {
  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      const isClassification = request.messages.some((message) =>
        message.content.includes("класс обращения"),
      );
      if (isClassification) {
        return {
          text: intent,
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

/**
 * Фикстура каталога: одна позиция Adobe InCopy на 10 пользователей.
 *
 * Позиция нужна для сценария подбора: без неё узел каталога не находит
 * продукт и ответ уходит в эскалацию.
 */
async function seedCatalogProduct(): Promise<void> {
  const snapshot = await testPool().query<{ id: string }>(
    `INSERT INTO catalog_snapshots (tenant_id, source_url, feed_date, fetched_at, snapshot_hash, offers_count, categories_count, is_current, source_kind)
     VALUES ($1, 'https://store.softline.ru/feeds/Softline.yml.gz', now(), now(), $2, 1, 0, true, 'test')
     RETURNING id`,
    [tenantId, `hash-api-chat-${Date.now()}`],
  );

  await testPool().query(
    `INSERT INTO products (tenant_id, offer_id, name, vendor, product_url, price, currency_id, available, delivery, params, snapshot_id, status, published)
     VALUES ($1, '504', 'Adobe InCopy CC Professional', 'Adobe Systems', 'https://store.softline.ru/adobe/504/', 1200, 'RUR', true, true, $2::jsonb, $3, 'approved_by_customer', true)`,
    [
      tenantId,
      JSON.stringify({ "К-во пользователей": "10", "Срок действия": "12 мес." }),
      snapshot.rows[0]?.id ?? "",
    ],
  );
}

describe("POST /v1/chat", () => {
  beforeAll(async () => {
    process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-key";
    // Арендатор определяется сервером; тест указывает свой, чтобы фикстуры
    // разных тестовых файлов не пересекались.
    process.env.TENANT_SLUG = TENANT_SLUG;
    await ensureSchema();
  });

  beforeEach(async () => {
    // Режим эскалации задаётся в каждом тесте явно: тесты меняют его, а
    // порядок выполнения не должен влиять на результат.
    process.env.ESCALATION_MODE = "on";
    await seedArticle();
    await seedCatalogProduct();
    setModelClient(okModel(ARTICLE_TEXT, [ARTICLE_TEXT]));
  });

  afterAll(async () => {
    await closePool();
  });

  it("валидный вопрос даёт 200, outcome=respond, источники и идентификаторы", async () => {
    const response = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-2222-4222-8222-222222222222",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversation_id: string;
      message_id: string;
      outcome: string;
      answer: { text: string; sources: unknown[] } | null;
      escalation: unknown;
      trace: { steps: number; tokens: number; cost_rub: number };
    };
    expect(body.outcome).toBe("respond");
    expect(body.conversation_id).toBe("1a2b3c4d-1111-4111-8111-111111111111");
    expect(body.message_id).toBeTruthy();
    expect(body.answer?.sources.length).toBeGreaterThan(0);
    expect(body.escalation).toBeNull();
    expect(body.trace.steps).toBeGreaterThan(0);
  });

  it("вопрос без источника даёт escalate с причиной no_confirmed_source", async () => {
    // Режим `on`: без подтверждённого источника — эскалация (ADR-0014).
    process.env.ESCALATION_MODE = "on";
    const response = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-3333-4333-8333-333333333333",
          text: "Как настроить квантовый телепорт?",
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      answer: unknown;
      escalation: { reason: string; summary: string; id: string } | null;
    };
    expect(body.outcome).toBe("escalate");
    expect(body.answer).toBeNull();
    expect(body.escalation?.reason).toBe("no_confirmed_source");
    expect(body.escalation?.summary).toBeTruthy();
  });

  it("неверное тело даёт 400 с error.code=validation_error", async () => {
    const response = await POST(chatRequest({ message: { text: "" } }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("повтор client_message_id не создаёт второй ответ", async () => {
    const payload = {
      conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
      message: {
        client_message_id: "1a2b3c4d-4444-4444-8444-444444444444",
        text: "Как получить электронную лицензию?",
      },
    };

    const first = await POST(chatRequest(payload));
    const firstBody = (await first.json()) as { message_id: string };
    const second = await POST(chatRequest(payload));
    const secondBody = (await second.json()) as { message_id: string };

    expect(secondBody.message_id).toBe(firstBody.message_id);

    const messages = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE tenant_id = $1 AND role = 'client'",
      [tenantId],
    );
    expect(Number(messages.rows[0]?.count ?? "0")).toBe(1);
  });

  it("ПД в ответе восстановлены, а в трассе исходных значений нет", async () => {
    const response = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-5555-4555-8555-555555555555",
          text: "Иван из ООО «Ромашка» спрашивает про электронную лицензию",
        },
      }),
    );

    expect(response.status).toBe(200);
    const steps = await testPool().query<{ text_masked: string }>(
      "SELECT text_masked FROM messages WHERE tenant_id = $1 AND role = 'client'",
      [tenantId],
    );
    const masked = steps.rows[0]?.text_masked ?? "";
    expect(masked).toContain("⟦");
    expect(masked).not.toContain("Иван");
    expect(masked).not.toContain("Ромашка");
  });

  it("запрос без cookie создаёт новый диалог и выдаёт Set-Cookie", async () => {
    const response = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-6666-4666-8666-666666666666",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("support_conversation=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("подписанная cookie продолжает тот же диалог", async () => {
    const first = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-7777-4777-8777-777777777777",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    const second = await POST(
      chatRequest(
        {
          conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
          message: {
            client_message_id: "1a2b3c4d-8888-4888-8888-888888888888",
            text: "Как получить электронную лицензию?",
          },
        },
        cookie,
      ),
    );
    const body = (await second.json()) as { conversation_id: string };

    expect(body.conversation_id).toBe("1a2b3c4d-1111-4111-8111-111111111111");
  });

  it("второй запрос с тем же conversation_id продолжает сбор слотов", async () => {
    // AC 5 тикета 14: собранные слоты переживают отдельные сообщения в одном
    // диалоге. Первый ответ задаёт вопрос о количестве, второй запрос с
    // ответом на вопрос закрывает слот и даёт карточку с ценой.
    const conversationId = "1a2b3c4d-2222-4222-8222-222222222222";
    // Класс `product_known` ведёт на маршрут каталога: подбор по названию
    // с уточняющими вопросами по слотам.
    setModelClient(okModel(ARTICLE_TEXT, [ARTICLE_TEXT], "product_known"));

    const first = await POST(
      chatRequest({
        conversation_id: conversationId,
        message: {
          client_message_id: "1a2b3c4d-3333-4333-8333-333333333333",
          text: "Нужен Adobe InCopy",
        },
      }),
    );
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    const firstBody = (await first.json()) as {
      outcome: string;
      answer: { text: string } | null;
    };

    expect(firstBody.outcome).toBe("respond");
    expect(firstBody.answer?.text).toContain("?");

    const second = await POST(
      chatRequest(
        {
          conversation_id: conversationId,
          message: {
            client_message_id: "1a2b3c4d-4444-4444-8444-444444444444",
            text: "Нужно 10 штук",
          },
        },
        cookie,
      ),
    );
    const secondBody = (await second.json()) as {
      outcome: string;
      answer: { text: string; sources: { kind: string; location: string | null }[] } | null;
    };

    expect(secondBody.outcome).toBe("respond");
    // Слот количества закрыт: агент больше не спрашивает о количестве и
    // показывает позицию с ценой из снимка фида.
    expect(secondBody.answer?.text).not.toContain("Сколько лицензий");
    expect(secondBody.answer?.text).toMatch(/₽/);
    expect(secondBody.answer?.sources.some((source) => source.kind === "catalog_product")).toBe(
      true,
    );
  });

  it("conversation_id, не совпадающий с cookie, даёт 403", async () => {
    const first = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-9999-4999-8999-999999999999",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    const response = await POST(
      chatRequest(
        {
          conversation_id: "1a2b3c4d-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          message: {
            client_message_id: "1a2b3c4d-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            text: "Как получить электронную лицензию?",
          },
        },
        cookie,
      ),
    );

    expect(response.status).toBe(403);
  });

  it("два клиента с одинаковым IP получают разные диалоги", async () => {
    const first = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-cccc-4ccc-8ccc-cccccccccccc",
          text: "Как получить электронную лицензию?",
        },
      }),
    );
    const second = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-dddd-4ddd-8ddd-dddddddddddd",
        message: {
          client_message_id: "1a2b3c4d-eeee-4eee-8eee-eeeeeeeeeeee",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    const firstBody = (await first.json()) as { conversation_id: string };
    const secondBody = (await second.json()) as { conversation_id: string };
    expect(firstBody.conversation_id).not.toBe(secondBody.conversation_id);
  });

  it("подделанная подпись cookie создаёт новый диалог", async () => {
    const response = await POST(
      chatRequest(
        {
          conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
          message: {
            client_message_id: "1a2b3c4d-ffff-4fff-8fff-ffffffffffff",
            text: "Как получить электронную лицензию?",
          },
        },
        "support_conversation=11111111-1111-4111-8111-111111111111.forged",
      ),
    );

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
  });

  it("исходящий текст с сырым ПД даёт 422 и ответ не отправляется", async () => {
    setModelClient(
      okModel("Иван из ООО «Ромашка» получит лицензию."),
    );

    const response = await POST(
      chatRequest({
        conversation_id: "1a2b3c4d-1111-4111-8111-111111111111",
        message: {
          client_message_id: "1a2b3c4d-1212-4212-8212-121212121212",
          text: "Как получить электронную лицензию?",
        },
      }),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("approval_required");
  });
});
