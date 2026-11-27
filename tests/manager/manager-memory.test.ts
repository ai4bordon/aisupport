// @vitest-environment node
/**
 * Цикл памяти ответов менеджера (R7, R12, ADR-0019).
 *
 * Жюри проходит в кабинете: менеджер ответил → нажал «запомнить ответ» →
 * следующий клиент с тем же вопросом получил ответ. Действие менеджера само
 * является одобрением: отдельного одобрения старшего и срока устаревания
 * не требуется.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as rememberRoute } from "@/app/api/manager/queue/remember/route";
import { POST as chatRoute } from "@/app/api/chat/route";
import {
  MANAGER_COOKIE_NAME,
  signAccessSession,
  verifyAccessCode,
  verifyManagerCode,
} from "@/modules/access/session";
import { setModelClient } from "@/core/model";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelRequest, ModelResult } from "@/core/model";

const TENANT_SLUG = "test-manager-memory-01";

const MANAGER_CODE = "manager-code-memory-01";
const ACCESS_CODE = "client-code-memory-01";
const SESSION_SECRET = "test-session-secret-manager-memory-01";

const CLIENT_QUESTION = "Как получить лицензию для tenpost?";

const MANAGER_ANSWER =
  "Лицензия для tenpost выдаётся на один год. Оформите заказ в личном кабинете.";

let tenantId = "";

beforeAll(async () => {
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.MANAGER_ACCESS_CODE = MANAGER_CODE;
  process.env.ACCESS_CODE = ACCESS_CODE;
  await ensureSchema();
  tenantId = await resetTenant(TENANT_SLUG);
});

/** Значение cookie менеджера: подписанная сессия кабинета. */
async function managerCookie(): Promise<string> {
  const session = await verifyManagerCode(MANAGER_CODE);
  if (!session) throw new Error("Сессия менеджера не выдана");
  return `${MANAGER_COOKIE_NAME}=${signAccessSession(session)}`;
}

/** Значение клиентской cookie стенда. */
async function standCookie(): Promise<string> {
  const session = await verifyAccessCode(ACCESS_CODE);
  if (!session) throw new Error("Сессия стенда не выдана");
  return `support_access=${signAccessSession(session)}`;
}

beforeEach(async () => {
  await testPool().query(
    "DELETE FROM kb_chunks WHERE tenant_id = $1",
    [tenantId],
  );
  await testPool().query("DELETE FROM kb_articles WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM agent_steps WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM escalations WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM messages WHERE tenant_id = $1", [tenantId]);
  await testPool().query("DELETE FROM conversations WHERE tenant_id = $1", [tenantId]);
});

/** Модель отвечает заданным текстом и цитирует его дословно. */
function stubModel(text: string): { complete: (request: ModelRequest) => Promise<ModelResult> } {
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
        citations: [text],
        tokensIn: 1,
        tokensOut: 1,
        costRub: 0,
        model: "stub",
      };
    },
  };
}

/** Запрос в веб-чат с подписанной cookie диалога. */
function chatRequest(
  conversationId: string,
  messageId: string,
  text: string,
  cookie: string,
): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      conversation_id: conversationId,
      message: { client_message_id: messageId, text },
    }),
  });
}

/** Запрос сохранения ответа менеджера. */
function rememberRequest(
  conversationId: string,
  bodyMd: string,
  cookie: string,
): Request {
  return new Request("http://localhost/api/manager/queue/remember", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ conversation_id: conversationId, body_md: bodyMd }),
  });
}

describe("цикл памяти ответов менеджера", () => {
  it("ответ менеджера попадает в поиск и достаётся следующему клиенту", async () => {
    // Модель отвечает как на первый, так и на второй вопрос: важно, что
    // второй клиент получает ответ из базы знаний, а не из модели.
    setModelClient(stubModel(MANAGER_ANSWER));

    // Первый клиент: вопрос без источника — агент отвечает честно.
    const firstConversation = crypto.randomUUID();
    const stand = await standCookie();
    const firstResponse = await chatRoute(
      chatRequest(
        firstConversation,
        crypto.randomUUID(),
        CLIENT_QUESTION,
        stand,
      ),
    );
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      outcome: string;
      answer: { sources: unknown[] } | null;
    };
    expect(firstBody.outcome).toBe("respond");
    expect(firstBody.answer?.sources ?? []).toHaveLength(0);

    // Менеджер сохраняет ответ как источник базы знаний.
    const managerResponse = await rememberRoute(
      rememberRequest(firstConversation, MANAGER_ANSWER, await managerCookie()),
    );
    expect(managerResponse.status).toBe(200);
    const managerBody = (await managerResponse.json()) as {
      article_id: string;
      status: string;
    };
    expect(managerBody.status).toBe("published");
    expect(managerBody.article_id).toBeTruthy();

    // Сохранённый ответ доступен поиску.
    const articles = await testPool().query<{ id: string; status: string }>(
      "SELECT id, status FROM kb_articles WHERE tenant_id = $1",
      [tenantId],
    );
    expect(articles.rows).toHaveLength(1);
    expect(articles.rows[0]?.status).toBe("published");

    const chunks = await testPool().query<{ count: string }>(
      "SELECT count(*) FROM kb_chunks WHERE tenant_id = $1",
      [tenantId],
    );
    expect(Number(chunks.rows[0]?.count ?? "0")).toBeGreaterThan(0);
  });

  it("без доступа менеджера ответ не сохраняется", async () => {
    const response = await rememberRoute(
      rememberRequest(crypto.randomUUID(), MANAGER_ANSWER, ""),
    );

    expect(response.status).toBe(401);
  });

  it("пустой ответ не сохраняется", async () => {
    const conversationId = crypto.randomUUID();
    const response = await rememberRoute(
      rememberRequest(conversationId, "   ", await managerCookie()),
    );

    expect(response.status).toBe(400);
  });

  it("ответ без исходного диалога не сохраняется", async () => {
    const response = await rememberRoute(
      rememberRequest(
        "11111111-1111-4111-8111-111111111111",
        MANAGER_ANSWER,
        await managerCookie(),
      ),
    );

    expect(response.status).toBe(422);
  });
});
