import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { runAgent } from "@/core/run";
import { appendDialogMessage } from "@/core/dialog-messages";
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
} from "@/core/dialog-history";
import { setModelClient } from "@/core/model";
import { currentEmbeddingProvider } from "@/modules/knowledge";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelClient, ModelRequest, ModelResult } from "@/core/model";

/**
 * История диалога доходит до промпта ответа.
 *
 * Диалог из трёх ходов: клиент называет продукт и количество («50 мест»),
 * затем задаёт уточняющий вопрос, и ответ агента на третьем ходу должен
 * опираться на первый. Раньше модель видела только текущую реплику, и
 * продукт с количеством из первого хода в ответ не попадали.
 *
 * Проверка идёт через подменённую модель: она читает переданные `messages`
 * и отвечает по данным из блока истории. Если история в промпт не дошла,
 * модель отвечает без продукта и количества, и тест падает.
 */

/** Арендатор теста: свой, чтобы не затирать фикстуры соседних файлов. */
const TENANT_SLUG = "test-dialog-history-in-prompt";

/**
 * Статья базы знаний.
 *
 * Слова статьи подобраны так, чтобы запросы всех трёх ходов находили её:
 * иначе ход ушёл бы в эскалацию, и до генерации ответа не дошёл бы.
 * Продукт и количество в статье не названы — взяться им больше неоткуда,
 * кроме истории диалога.
 */
const ARTICLE_TEXT =
  "Подбор лицензии выполняется по каталогу позиций. Количество мест задаёт клиент.";

/** Первый ход: клиент называет продукт и количество. */
const FIRST_TURN = "Подбор: нужно 50 мест на MDaemon Standard";
/** Второй ход: уточняющий вопрос клиента. */
const SECOND_TURN = "Подбор лицензии: какой срок у позиции?";
/** Третий ход: продукт и количество в тексте хода не названы. */
const THIRD_TURN = "Подбор лицензии: что в итоге?";

/** Продукт и количество из первого хода. */
const PRODUCT = "MDaemon Standard";
const QUANTITY = "50 мест";

let tenantId = "";
let conversationId = "";

type ModelState = {
  /** Промпт последнего вызова генерации: по нему проверяется история. */
  prompt: string;
  /** Блок истории из промпта: пустая строка, если истории не было. */
  history: string;
};

/**
 * Модель, читающая промпт.
 *
 * Классификатор отвечает кодом класса, генератор — по данным из блока
 * истории: продукт и количество появляются в ответе только тогда, когда
 * они дошли до промпта.
 */
function historyAwareModel(state: ModelState): ModelClient {
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

      state.prompt = request.messages.map((message) => message.content).join("\n");
      state.history =
        request.messages.find((message) =>
          message.content.startsWith("История диалога"),
        )?.content ?? "";

      const knowsFromHistory =
        state.history.includes(QUANTITY) && state.history.includes(PRODUCT);

      return {
        text: knowsFromHistory
          ? `Подберу ${PRODUCT} на ${QUANTITY}.`
          : "Нужны детали подбора: уточните продукт и количество.",
        amounts: [],
        citations: [],
        tokensIn: 20,
        tokensOut: 20,
        costRub: 0.1,
        model: "stub-model",
      };
    },
  };
}

/** Создаёт диалог и возвращает его идентификатор. */
async function newConversation(): Promise<string> {
  const id = crypto.randomUUID();
  await testPool().query(
    `INSERT INTO conversations (id, tenant_id, channel, status)
     VALUES ($1, $2, 'web', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [id, tenantId],
  );
  return id;
}

/**
 * Записывает сообщение в переписку диалога.
 *
 * Так же поступает канал: реплика клиента и ответ агента живут в таблице
 * `messages`, и ядро читает их оттуда.
 */
async function appendMessage(
  conversation: string,
  role: "client" | "agent",
  text: string,
): Promise<void> {
  await appendDialogMessage({
    tenantId,
    conversationId: conversation,
    clientMessageId: crypto.randomUUID(),
    role,
    maskedText: text,
    originalText: null,
    sources: [],
  });
}

describe("история диалога в промпте ответа", () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    // Режим эскалации задаётся явно: тест меняет его, а порядок выполнения
    // не должен влиять на результат.
    process.env.ESCALATION_MODE = "on";
    tenantId = await resetTenant(TENANT_SLUG);

    const article = await testPool().query<{ id: string }>(
      `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
       VALUES ($1, 'Подбор лицензии', $2, 'published', now(), now())
       RETURNING id`,
      [tenantId, ARTICLE_TEXT],
    );
    const embedding = await currentEmbeddingProvider().embed(ARTICLE_TEXT);
    await testPool().query(
      `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
       VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
      [tenantId, article.rows[0]?.id ?? "", ARTICLE_TEXT, `[${embedding.join(",")}]`],
    );

    conversationId = await newConversation();
  });

  afterAll(async () => {
    // Подмена клиента модели снимается: воркер Vitest переиспользуется между
    // файлами, и без снятия соседний тест получил бы заглушку этого файла
    // вместо своего клиента.
    setModelClient(null);
    await closePool();
  });

  it("ответ третьего хода опирается на продукт и количество из первого", async () => {
    const state: ModelState = { prompt: "", history: "" };
    setModelClient(historyAwareModel(state));

    // Первый ход: клиент называет продукт и количество.
    const first = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: FIRST_TURN,
      maskedFieldsCount: 0,
      tenantId,
    });
    expect(first.outcome).toBe("respond");
    if (first.outcome !== "respond") return;
    await appendMessage(conversationId, "client", FIRST_TURN);
    await appendMessage(conversationId, "agent", first.answer.text);

    // Второй ход: клиент задаёт уточняющий вопрос.
    const second = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: SECOND_TURN,
      maskedFieldsCount: 0,
      tenantId,
    });
    expect(second.outcome).toBe("respond");
    if (second.outcome !== "respond") return;
    await appendMessage(conversationId, "client", SECOND_TURN);
    await appendMessage(conversationId, "agent", second.answer.text);

    // Третий ход: ответ агента должен собрать продукт и количество из
    // первого хода — в тексте хода их нет.
    const third = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: THIRD_TURN,
      maskedFieldsCount: 0,
      tenantId,
    });

    // Блок истории дошёл до промпта.
    expect(state.history).not.toBe("");
    expect(state.history).toContain(QUANTITY);
    expect(state.history).toContain(PRODUCT);
    // В истории виден и уточняющий вопрос второго хода.
    expect(state.history).toContain("какой срок у позиции");

    expect(third.outcome).toBe("respond");
    if (third.outcome !== "respond") return;
    expect(third.answer.text).toContain(QUANTITY);
    expect(third.answer.text).toContain(PRODUCT);
  });

  it("в новом диалоге истории нет, и ответ остаётся без продукта", async () => {
    const state: ModelState = { prompt: "", history: "" };
    setModelClient(historyAwareModel(state));

    const conversation = await newConversation();
    const outcome = await runAgent({
      conversationId: conversation,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: THIRD_TURN,
      maskedFieldsCount: 0,
      tenantId,
    });

    // Блока истории в промпте нет: переписка диалога пуста.
    expect(state.history).toBe("");
    expect(state.prompt).not.toContain("История диалога");

    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;
    expect(outcome.answer.text).not.toContain(PRODUCT);
    expect(outcome.answer.text).not.toContain(QUANTITY);
  });

  it("бюджет истории ограничен: длинная переписка не раздувает промпт", async () => {
    const state: ModelState = { prompt: "", history: "" };
    setModelClient(historyAwareModel(state));

    // Двенадцать ходов по длинной реплике: переписка длиннее бюджета
    // истории в несколько раз.
    for (let index = 0; index < 12; index += 1) {
      const text = `Ход ${index}: ${"подробное описание подбора ".repeat(20)}`;
      await appendMessage(conversationId, "client", text);
      await appendMessage(conversationId, "agent", `Ответ ${index}`);
    }

    await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: THIRD_TURN,
      maskedFieldsCount: 0,
      tenantId,
    });

    // Блок истории не превышает бюджет по символам.
    expect(state.history.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    // Число сообщений в блоке ограничено отдельно от числа символов.
    const lines = state.history
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    // Каждое сообщение обрезано: длинная реплика не занимает весь блок.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGE_CHARS + 32);
    }
  });

  it("история не ломает подбор по каталогу: слоты собираются как раньше", async () => {
    // Подбор по каталогу идёт по слотам, а не по истории: клиент называет
    // продукт, агент уточняет количество, и ответ содержит позицию с ценой.
    // История диалога не должна перехватывать этот путь.
    const state: ModelState = { prompt: "", history: "" };
    setModelClient(historyAwareModel(state));

    await appendMessage(conversationId, "client", FIRST_TURN);
    await appendMessage(conversationId, "agent", "Уточните количество мест.");

    const outcome = await runAgent({
      conversationId,
      messageId: crypto.randomUUID(),
      channel: "web",
      externalChatId: null,
      text: "Нужно 50 мест",
      maskedFieldsCount: 0,
      tenantId,
    });

    // Ответ пришёл, и валидация прошла: подбор не превратился в эскалацию.
    expect(outcome.outcome).toBe("respond");
    const validate = outcome.steps.find((step) => step.node === "validate");
    expect(validate?.metadata["violationCount"] ?? 0).toBe(0);
  });
});
