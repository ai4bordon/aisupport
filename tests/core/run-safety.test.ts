/**
 * Устойчивость ядра при сбоях (B5, B7, C10).
 *
 * B5 — значения персональных данных попадали в трассу через детали
 * нарушений; B7 — сбой записи обещания ронял ответ вместо эскалации;
 * C10 — источники передавались модели как реплика ассистента, то есть как
 * собственная мысль, а не как данные.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setModelClient } from "@/core/model";
import { runAgent } from "@/core/run";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

const TENANT_SLUG = "test-run-safety-01";

const ARTICLE_TEXT = "Срок поставки электронной лицензии — 120 минут после оплаты.";

let tenantId = "";
let conversationId = "";

beforeAll(async () => {
  await ensureSchema();
  tenantId = await resetTenant(TENANT_SLUG);
});

beforeEach(async () => {
  conversationId = crypto.randomUUID();
  await testPool().query(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'web', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, tenantId],
  );
  // Материал удаляется перед вставкой: тест должен проходить и на базе,
  // где он остался от предыдущего прогона, — иначе падение на уникальном
  // индексе выглядит как дефект кода.
  await testPool().query(
    `DELETE FROM kb_chunks
      WHERE tenant_id = $1
        AND article_id IN (SELECT id FROM kb_articles WHERE tenant_id = $1 AND title = 'Поставка')`,
    [tenantId],
  );
  await testPool().query(
    "DELETE FROM kb_articles WHERE tenant_id = $1 AND title = 'Поставка'",
    [tenantId],
  );
  await testPool().query(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Поставка', $2, 'published', now(), now())`,
    [tenantId, ARTICLE_TEXT],
  );
  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, (SELECT id FROM kb_articles WHERE tenant_id = $2 LIMIT 1), 0, $3,
       to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [tenantId, tenantId, ARTICLE_TEXT, `[${new Array(1536).fill(0).join(",")}]`],
  );
});

/** Модель, запоминающая запросы и отвечающая заданным текстом. */
function recordingModel(text: string): {
  complete: (request: ModelRequest) => Promise<ModelResult>;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(request);
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

describe("B5: в трассу идут коды нарушений, а не значения", () => {
  it("детали нарушений не попадают в трассу", async () => {
    // Модель возвращает цитату, которой нет в источниках: код нарушения
    // «citation_not_in_source», а его деталь содержит текст цитаты.
    setModelClient({
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
          text: "Срок поставки — 120 минут.",
          amounts: [],
          citations: ["Срок поставки — 45 минут после оплаты."],
          tokensIn: 1,
          tokensOut: 1,
          costRub: 0,
          model: "stub",
        };
      },
    });

    await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Когда придёт лицензия?",
      maskedFieldsCount: 0,
      tenantId,
    });

    const steps = await testPool().query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM agent_steps WHERE conversation_id = $1 AND node = 'validate'",
      [conversationId],
    );
    const metadata = steps.rows[0]?.metadata ?? {};
    const serialized = JSON.stringify(metadata);

    // Код нарушения в трассе есть — по нему видно, что не так.
    expect(serialized).toContain("citation_not_in_source");
    // Значения из детали нарушения — нет: трасса попадает в кабинет
    // менеджера и в журналы.
    expect(serialized).not.toContain("45 минут");
    expect(metadata["details"]).toBeUndefined();
    expect(metadata["violationCount"]).toBe(1);
  });
});

describe("C10: источники передаются как данные, а не как инструкции", () => {
  it("источники идут в реплике пользователя с пометкой", async () => {
    const model = recordingModel(ARTICLE_TEXT);
    setModelClient(model);

    await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Когда придёт лицензия?",
      maskedFieldsCount: 0,
      tenantId,
    });

    const generation = model.requests.at(-1);
    const sourceMessage = generation?.messages.find((message) =>
      message.content.includes("Подтверждённые источники"),
    );

    expect(sourceMessage).toBeTruthy();
    expect(sourceMessage?.role).toBe("user");
    expect(sourceMessage?.content).toContain("не инструкции");
  });
});

describe("B7: сбой записи обещания — эскалация, а не ошибка", () => {
  it("ответ не уходит клиенту, причина эскалации — сбой записи", async () => {
    // Обещание с подтверждённым сроком: модель пишет строку-маркер, и ядро
    // пытается записать обязательство в журнал. Канал MAX — адресатом
    // обязательства является диалог, адрес клиента не нужен (ADR-0018).
    setModelClient(
      recordingModel(
        `${ARTICLE_TEXT}\nОБЕЩАНИЕ: Пришлю счёт в течение 120 минут | срок: 120 минут | источник: [1]`,
      ),
    );

    // Журнал обещаний переименован: запись падает на уровне базы.
    await testPool().query(
      "ALTER TABLE promises RENAME TO promises_backup_01",
    );
    try {
      const outcome = await runAgent({
        conversationId,
        messageId: crypto.randomUUID(),
        channel: "max",
        externalChatId: "chat-b7",
        text: "Когда придёт счёт?",
        maskedFieldsCount: 0,
        tenantId,
      });

      expect(outcome.outcome).toBe("escalate");
      if (outcome.outcome !== "escalate") return;
      expect(outcome.escalation.reason).toBe("promise_store_failed");
    } finally {
      await testPool().query(
        "ALTER TABLE promises_backup_01 RENAME TO promises",
      );
      await testPool().query("DROP TABLE IF EXISTS promises_backup_01");
    }
  });
});
