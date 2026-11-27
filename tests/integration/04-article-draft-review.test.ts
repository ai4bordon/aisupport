import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { runAgent } from "@/core/run";
import { setModelClient } from "@/core/model";
import { currentEmbeddingProvider, search } from "@/modules/knowledge";
import {
  approveArticleDraft,
  createArticleDraft,
  publishArticleDraft,
  rejectArticleDraft,
} from "@/modules/article-drafts";
import {
  MANAGER_COOKIE_NAME,
  signAccessSession,
  verifyAccessCode,
  verifyManagerCode,
} from "@/modules/access/session";
import { POST as createDraftRoute } from "@/app/api/kb/drafts/route";
import { POST as approveDraftRoute } from "@/app/api/kb/drafts/[id]/approve/route";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import type { ModelClient, ModelResult } from "@/core/model";

/**
 * Интеграционный тест среза 04: менеджер создаёт черновик статьи из
 * материалов диалога, дожидается явного одобрения, и только после этого
 * статья становится доступна поиску базы знаний.
 *
 * Команда проверки: npm run test -- tests/integration/04-article-draft-review.test.ts
 *
 * Модель подменяется на границе: реальных ключей у среза нет, поэтому
 * проверяется поведение среза, а не живой вызов провайдера.
 */
const TENANT_SLUG = "test-integration-04";

/** Уникальная фраза материала: её наличие в выдаче означает утечку черновика. */
const DRAFT_PHRASE = "квота обновления лицензии продлевается автоматически";

/**
 * Текст статьи.
 *
 * Он длиннее одного предложения, чтобы нарезка на чанки дала цитируемый
 * материал: короткий текст не помещается в чанк контрактного размера.
 */
const ARTICLE_BODY = [
  "Квота обновления лицензии продлевается автоматически после оплаты.",
  "Продление занимает до пятнадцати минут и не требует отдельной заявки.",
  "Если срок действия лицензии закончился, продление не выполняется: лицензию нужно оформить заново.",
  "Менеджер кабинета видит срок продления в карточке клиента.",
  "Статья подготовлена из материалов диалога и ждёт решения менеджера.",
  "До публикации материал не попадает в поиск базы знаний.",
].join(" ");

/**
 * Текст синтетического документа.
 *
 * Ни одного общего значимого слова с текстом статьи: иначе проверка
 * «документ не появился в поиске» нашла бы статью по этому слову и
 * выглядела бы как утечка документа.
 */
const DOCUMENT_TEXT =
  "Регламент обслуживания серверного парка: оборудование меняется согласно плану.";

let tenantId = "";

/** Подготовка диалога: источник, из которого менеджер собирает статью. */
type DialogFixture = {
  conversationId: string;
  messageIds: string[];
};

async function seedDialog(ownerTenantId: string = tenantId): Promise<DialogFixture> {
  const conversation = await testPool().query<{ id: string }>(
    "INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id",
    [ownerTenantId],
  );
  const conversationId = conversation.rows[0]?.id ?? "";

  const messages = await testPool().query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked)
     VALUES
       ($1, $2, gen_random_uuid(), 'client', 'Квота обновления лицензии продлевается автоматически'),
       ($1, $2, gen_random_uuid(), 'client', 'Подскажите порядок продления')
     RETURNING id`,
    [ownerTenantId, conversationId],
  );

  return { conversationId, messageIds: messages.rows.map((row) => row.id) };
}

/**
 * Индексный чанк статьи.
 *
 * Чанк пишется напрямую, минуя модуль: так проверка фиксирует, что
 * изоляция держится на фильтре допуска в поиске, а не на том, что черновик
 * просто не проиндексирован. Материал, проиндексированный в обход потока,
 * в выдачу попасть не должен.
 */
async function seedChunk(articleId: string, text: string): Promise<void> {
  const provider = currentEmbeddingProvider();
  const vector = await provider.embed(text);
  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, $5)`,
    [
      tenantId,
      articleId,
      text,
      `[${vector.join(",")}]`,
      provider.model,
    ],
  );
}

/** Модель, которая отвечает по памяти: ответ без источника не должен дойти. */
function memoryModel(): ModelClient {
  return {
    complete: async (): Promise<ModelResult> => ({
      text: "Ответ из памяти модели без подтверждённого источника.",
      amounts: [],
      citations: [],
      tokensIn: 10,
      tokensOut: 10,
      costRub: 0,
      model: "stub-model",
    }),
  };
}

/** Код менеджера теста: подпись cookie проверяется по нему же. */
const MANAGER_CODE = "manager-code-04";
const ACCESS_CODE = "stand-code-04";

/** Значение cookie менеджера: подписанная сессия кабинета. */
async function managerCookie(): Promise<string> {
  const session = await verifyManagerCode(MANAGER_CODE);
  if (!session) throw new Error("Сессия менеджера не выдана");
  return `${MANAGER_COOKIE_NAME}=${signAccessSession(session)}`;
}

/** Значение клиентской cookie стенда: в кабинет менеджера она не пускает. */
async function standCookie(): Promise<string> {
  const session = await verifyAccessCode(ACCESS_CODE);
  if (!session) throw new Error("Сессия стенда не выдана");
  return `support_access=${signAccessSession(session)}`;
}

/** Запрос к маршруту черновиков. */
function draftRequest(
  path: string,
  body: unknown,
  cookie?: string,
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("04 — черновики статей из материалов диалога", () => {
  beforeAll(async () => {
    // Коды и секрет подписи — тестовые: реальных ключей у среза нет.
    process.env.SESSION_SECRET ??= "test-session-secret-article-drafts-04";
    process.env.MANAGER_ACCESS_CODE = MANAGER_CODE;
    process.env.ACCESS_CODE = ACCESS_CODE;
    await ensureSchema();
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
  });

  afterAll(async () => {
    await closePool();
  });

  it("AC1: менеджер создаёт черновик из сообщений диалога и видит статус ожидания", async () => {
    const dialog = await seedDialog();

    const draft = await createArticleDraft({
      tenantId,
      actor: "manager-1",
      conversationId: dialog.conversationId,
      sourceMessageIds: dialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: "Квота обновления лицензии продлевается автоматически после оплаты.",
    });

    expect(draft.status).toBe("pending_review");
    expect(draft.conversationId).toBe(dialog.conversationId);
    expect(draft.sourceMessageIds).toEqual(dialog.messageIds);
    expect(draft.sourceExcerpt).toContain("Квота обновления");
    expect(draft.title).toBe("Продление квоты лицензии");

    const row = await testPool().query<{
      status: string;
      conversation_id: string;
      source_message_ids: string[];
      source_excerpt: string;
      owner: string;
    }>(
      `SELECT status, conversation_id, source_message_ids, source_excerpt, owner
       FROM kb_articles WHERE id = $1`,
      [draft.id],
    );
    expect(row.rows[0]?.status).toBe("pending_review");
    expect(row.rows[0]?.conversation_id).toBe(dialog.conversationId);
    expect(row.rows[0]?.source_message_ids).toEqual(dialog.messageIds);
    expect(row.rows[0]?.source_excerpt).toContain("Квота обновления");
    expect(row.rows[0]?.owner).toBe("manager-1");
  });

  it("изоляция источника: чужой диалог и сообщение из другого диалога отклоняются без записи", async () => {
    const dialog = await seedDialog();
    const otherDialog = await seedDialog();
    const before = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_articles WHERE tenant_id = $1",
      [tenantId],
    );

    // Сообщение из другого диалога не может войти в провенанс.
    await expect(
      createArticleDraft({
        tenantId,
        actor: "manager-1",
        conversationId: dialog.conversationId,
        sourceMessageIds: [otherDialog.messageIds[0] ?? ""],
        sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
        title: "Продление квоты лицензии",
        bodyMd: ARTICLE_BODY,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    // Несуществующий диалог — тоже ошибка проверки, а не «создалось что-то».
    await expect(
      createArticleDraft({
        tenantId,
        actor: "manager-1",
        conversationId: "11111111-1111-4111-8111-111111111111",
        sourceMessageIds: dialog.messageIds,
        sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
        title: "Продление квоты лицензии",
        bodyMd: ARTICLE_BODY,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    // Диалог чужого арендатора не принимается.
    const otherTenantId = await resetTenant("test-integration-04-foreign");
    const foreignDialog = await seedDialog(otherTenantId);
    await expect(
      createArticleDraft({
        tenantId,
        actor: "manager-1",
        conversationId: foreignDialog.conversationId,
        sourceMessageIds: foreignDialog.messageIds,
        sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
        title: "Продление квоты лицензии",
        bodyMd: ARTICLE_BODY,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    const after = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_articles WHERE tenant_id = $1",
      [tenantId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("AC2: ожидающий и отклонённый черновик не попадают в поиск и в ответ агента", async () => {
    const dialog = await seedDialog();
    const draft = await createArticleDraft({
      tenantId,
      actor: "manager-1",
      conversationId: dialog.conversationId,
      sourceMessageIds: dialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: "Квота обновления лицензии продлевается автоматически после оплаты.",
    });
    // Чанк проиндексирован в обход потока: изоляцию держит фильтр допуска
    // в поиске, а не отсутствие индексации.
    await seedChunk(draft.id, DRAFT_PHRASE);

    const pending = await search(DRAFT_PHRASE, tenantId);
    expect(pending).toEqual([]);

    // Агент по тому же вопросу не строит ответ на черновике.
    setModelClient(memoryModel());
    process.env.ESCALATION_MODE = "on";
    const outcome = await runAgent({
      conversationId: dialog.conversationId,
      messageId: "11111111-1111-4111-8111-111111111111",
      channel: "web",
      externalChatId: null,
      text: "Как продлевается квота обновления лицензии?",
      maskedFieldsCount: 0,
      tenantId,
    });
    expect(outcome.outcome).toBe("escalate");
    if (outcome.outcome !== "escalate") return;
    expect(outcome.escalation.reason).toBe("no_confirmed_source");
    expect(outcome.answer).toBeNull();
    // Черновика нет ни в источниках, ни в трассе: агент о нём не знает.
    const retrieveStep = outcome.steps.find((step) => step.node === "retrieve");
    expect(retrieveStep?.sourceIds ?? []).not.toContain(draft.id);
    expect(retrieveStep?.metadata["matches"] ?? 0).toBe(0);
    // Эскалация не цитирует материал черновика.
    expect(outcome.escalation.draft ?? "").not.toContain("квота обновления");
    expect(outcome.escalation.summary).not.toContain("квота обновления");

    // Отклонённый материал остаётся вне выдачи.
    await rejectArticleDraft({
      tenantId,
      id: draft.id,
      actor: "manager-2",
    });
    const rejected = await search(DRAFT_PHRASE, tenantId);
    expect(rejected).toEqual([]);
  });

  it("AC3: после одобрения и публикации поиск возвращает статью со ссылкой на исходный диалог", async () => {
    const dialog = await seedDialog();
    const draft = await createArticleDraft({
      tenantId,
      actor: "manager-1",
      conversationId: dialog.conversationId,
      sourceMessageIds: dialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: ARTICLE_BODY,
    });

    const approved = await approveArticleDraft({
      tenantId,
      id: draft.id,
      actor: "manager-1",
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("manager-1");
    expect(approved.reviewedAt).not.toBeNull();

    const published = await publishArticleDraft({ tenantId, id: draft.id });
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();

    const matches = await search(DRAFT_PHRASE, tenantId);
    expect(matches.length).toBeGreaterThan(0);
    const match = matches[0];
    expect(match?.kind).toBe("kb_article");
    expect(match?.articleId).toBe(draft.id);
    expect(match?.title).toBe("Продление квоты лицензии");
    expect(match?.text).toContain("Квота обновления лицензии");
    // Ссылка на источник указывает на исходный диалог, а не на выдуманный URL.
    expect(match?.location).toBe(`диалог ${dialog.conversationId}`);
    expect(match?.location ?? "").not.toContain("http");

    // Провенанс остался в базе: ссылка выводится из исходного материала.
    const row = await testPool().query<{
      conversation_id: string;
      source_message_ids: string[];
      source_excerpt: string;
      published_at: Date | null;
    }>(
      `SELECT conversation_id, source_message_ids, source_excerpt, published_at
       FROM kb_articles WHERE id = $1`,
      [draft.id],
    );
    expect(row.rows[0]?.conversation_id).toBe(dialog.conversationId);
    expect(row.rows[0]?.source_message_ids).toEqual(dialog.messageIds);
    expect(row.rows[0]?.source_excerpt).toContain("Квота обновления");
    expect(row.rows[0]?.published_at).toBeInstanceOf(Date);
  });

  it("обе ветви поиска — векторная и полнотекстовая — находят только опубликованную статью", async () => {
    const dialog = await seedDialog();
    const draft = await createArticleDraft({
      tenantId,
      actor: "manager-1",
      conversationId: dialog.conversationId,
      sourceMessageIds: dialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: ARTICLE_BODY,
    });
    await approveArticleDraft({ tenantId, id: draft.id, actor: "manager-1" });
    await publishArticleDraft({ tenantId, id: draft.id });

    // Векторная ветвь: совпадение по смыслу вопроса с материалом статьи.
    const vectorMatches = await search("квота обновления лицензии продлевается автоматически", tenantId);
    expect(vectorMatches.length).toBeGreaterThan(0);
    expect(vectorMatches[0]?.kind).toBe("kb_article");
    expect(vectorMatches[0]?.articleId).toBe(draft.id);

    // Полнотекстовая ветвь: словоформа, которой нет в векторе запроса,
    // но которую находит `tsvector`. Счётчик ветви различается по величине
    // score: косинус близок к единице, ранг `ts_rank` — доли процента.
    const textMatches = await search("квотами", tenantId);
    expect(textMatches.length).toBeGreaterThan(0);
    expect(textMatches[0]?.articleId).toBe(draft.id);
    expect(textMatches[0]?.score ?? 1).toBeLessThan(0.25);

    // Обе ветви применяют один и тот же allowlist: ожидающий черновик не
    // находится ни вектором, ни текстом.
    await testPool().query(
      "UPDATE kb_articles SET status = 'pending_review' WHERE id = $1",
      [draft.id],
    );
    expect(await search("квота обновления лицензии продлевается автоматически", tenantId)).toEqual([]);
    expect(await search("квотами", tenantId)).toEqual([]);
  });

  it("AC5: агент до утверждения не ссылается на черновик, после публикации — цитирует статью", async () => {
    const dialog = await seedDialog();
    const draft = await createArticleDraft({
      tenantId,
      actor: "manager-1",
      conversationId: dialog.conversationId,
      sourceMessageIds: dialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: ARTICLE_BODY,
    });

    // До утверждения источника нет: агент эскалирует и не строит ответ.
    setModelClient(memoryModel());
    process.env.ESCALATION_MODE = "on";
    const before = await runAgent({
      conversationId: dialog.conversationId,
      messageId: "22222222-2222-4222-8222-222222222222",
      channel: "web",
      externalChatId: null,
      text: "Как продлевается квота обновления лицензии?",
      maskedFieldsCount: 0,
      tenantId,
    });
    expect(before.outcome).toBe("escalate");
    if (before.outcome !== "escalate") return;
    expect(before.escalation.reason).toBe("no_confirmed_source");
    expect(before.escalation.draft ?? "").not.toContain("квота обновления");

    await approveArticleDraft({ tenantId, id: draft.id, actor: "manager-1" });
    await publishArticleDraft({ tenantId, id: draft.id });

    // После публикации агент опирается на статью и цитирует её.
    setModelClient({
      complete: async (): Promise<ModelResult> => ({
        text: "Квота обновления лицензии продлевается автоматически после оплаты.",
        amounts: [],
        citations: ["Квота обновления лицензии продлевается автоматически"],
        tokensIn: 20,
        tokensOut: 12,
        costRub: 0,
        model: "stub-model",
      }),
    });
    const after = await runAgent({
      conversationId: dialog.conversationId,
      messageId: "33333333-3333-4333-8333-333333333333",
      channel: "web",
      externalChatId: null,
      text: "Как продлевается квота обновления лицензии?",
      maskedFieldsCount: 0,
      tenantId,
    });
    expect(after.outcome).toBe("respond");
    if (after.outcome !== "respond") return;
    expect(after.answer.text).toContain("продлевается автоматически");
    // URL в клиентском тексте нет: ссылка остаётся в источниках.
    expect(after.answer.text).not.toContain("http");
    const articleSource = after.answer.sources.find(
      (source) => source.kind === "kb_article" && source.id === draft.id,
    );
    expect(articleSource).toBeDefined();
    expect(articleSource?.location).toBe(`диалог ${dialog.conversationId}`);
  });

  it("AC4: HTTP-маршрут черновиков отделён от документов и закрыт барьером менеджера", async () => {
    const dialog = await seedDialog();
    const cookie = await managerCookie();

    // Без cookie менеджера — 401, запись не создаётся.
    const before = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_articles WHERE tenant_id = $1",
      [tenantId],
    );
    const anonymous = await createDraftRoute(
      draftRequest("/api/kb/drafts", {
        conversation_id: dialog.conversationId,
        source_message_ids: dialog.messageIds,
        source_excerpt: "Квота обновления лицензии продлевается автоматически",
        title: "Продление квоты лицензии",
        body_md: ARTICLE_BODY,
      }),
    );
    expect(anonymous.status).toBe(401);
    const afterAnonymous = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_articles WHERE tenant_id = $1",
      [tenantId],
    );
    expect(afterAnonymous.rows[0]?.count).toBe(before.rows[0]?.count);

    // Только клиентская cookie стенда — тоже 401: кабинет менеджера
    // требует отдельного кода (R17).
    const standOnly = await createDraftRoute(
      draftRequest(
        "/api/kb/drafts",
        {
          conversation_id: dialog.conversationId,
          source_message_ids: dialog.messageIds,
          source_excerpt: "Квота обновления лицензии продлевается автоматически",
          title: "Продление квоты лицензии",
          body_md: ARTICLE_BODY,
        },
        await standCookie(),
      ),
    );
    expect(standOnly.status).toBe(401);

    // Сессия менеджера: 201 и статус ожидания.
    const created = await createDraftRoute(
      draftRequest(
        "/api/kb/drafts",
        {
          conversation_id: dialog.conversationId,
          source_message_ids: dialog.messageIds,
          source_excerpt: "Квота обновления лицензии продлевается автоматически",
          title: "Продление квоты лицензии",
          body_md: ARTICLE_BODY,
          // Арендатор из тела не принимается: значение подставляет сервер.
          tenant_id: "11111111-1111-4111-8111-111111111111",
        },
        cookie,
      ),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: string;
      status: string;
      conversation_id: string;
      source_message_ids: string[];
      title: string;
      created_at: string;
    };
    expect(createdBody.status).toBe("pending_review");
    expect(createdBody.conversation_id).toBe(dialog.conversationId);
    expect(createdBody.source_message_ids).toEqual(dialog.messageIds);
    expect(createdBody.title).toBe("Продление квоты лицензии");
    expect(createdBody.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    // Синтетический документ в ожидании: операции над статьёй его не трогают.
    const document = await testPool().query<{ id: string }>(
      `INSERT INTO kb_documents (tenant_id, filename, mime_type, size_bytes, storage_path, status)
       VALUES ($1, 'pending.pdf', 'application/pdf', 100, '/tmp/pending.pdf', 'pending')
       RETURNING id`,
      [tenantId],
    );
    await testPool().query(
      `INSERT INTO kb_chunks (tenant_id, document_id, chunk_no, text, search_vector, embedding, embedding_model)
       VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, $5)`,
      [
        tenantId,
        document.rows[0]?.id ?? "",
        DOCUMENT_TEXT,
        `[${(await currentEmbeddingProvider().embed(DOCUMENT_TEXT)).join(",")}]`,
        currentEmbeddingProvider().model,
      ],
    );

    // Одобрение и публикация черновика: 200 и статус published.
    const approved = await approveDraftRoute(
      draftRequest(
        `/api/kb/drafts/${createdBody.id}/approve`,
        { actor: "manager-1" },
        cookie,
      ),
      { params: Promise.resolve({ id: createdBody.id }) },
    );
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { status: string; id: string };
    expect(approvedBody.status).toBe("published");
    expect(approvedBody.id).toBe(createdBody.id);

    // Повторное одобрение — конфликт состояния.
    const repeated = await approveDraftRoute(
      draftRequest(
        `/api/kb/drafts/${createdBody.id}/approve`,
        { actor: "manager-1" },
        cookie,
      ),
      { params: Promise.resolve({ id: createdBody.id }) },
    );
    expect(repeated.status).toBe(409);
    const repeatedBody = (await repeated.json()) as { error: { code: string } };
    expect(repeatedBody.error.code).toBe("conflict");

    // Документ остался в ожидании и в поиск не попал.
    const documentRow = await testPool().query<{ status: string }>(
      "SELECT status FROM kb_documents WHERE id = $1",
      [document.rows[0]?.id ?? ""],
    );
    expect(documentRow.rows[0]?.status).toBe("pending");
    const documentMatches = await search(DOCUMENT_TEXT, tenantId);
    expect(documentMatches).toEqual([]);

    // Опубликованная статья доступна поиску.
    const articleMatches = await search(DRAFT_PHRASE, tenantId);
    expect(articleMatches.length).toBeGreaterThan(0);
    expect(articleMatches[0]?.articleId).toBe(createdBody.id);
  });

  it("изоляция арендаторов: черновик одного арендатора не виден другому", async () => {
    const dialog = await seedDialog();
    const draft = await createArticleDraft({
      tenantId,
      actor: "manager-1",
      conversationId: dialog.conversationId,
      sourceMessageIds: dialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: ARTICLE_BODY,
    });
    await approveArticleDraft({ tenantId, id: draft.id, actor: "manager-1" });
    await publishArticleDraft({ tenantId, id: draft.id });

    // Второй арендатор: свой диалог, своя статья.
    const otherTenantId = await resetTenant("test-integration-04-other");
    const otherDialog = await seedDialog(otherTenantId);
    const otherDraft = await createArticleDraft({
      tenantId: otherTenantId,
      actor: "manager-2",
      conversationId: otherDialog.conversationId,
      sourceMessageIds: otherDialog.messageIds,
      sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
      title: "Продление квоты лицензии",
      bodyMd: ARTICLE_BODY,
    });
    await approveArticleDraft({
      tenantId: otherTenantId,
      id: otherDraft.id,
      actor: "manager-2",
    });
    await publishArticleDraft({ tenantId: otherTenantId, id: otherDraft.id });

    // Каждый арендатор видит только свою статью.
    const own = await search(DRAFT_PHRASE, tenantId);
    expect(own.every((match) => match.articleId === draft.id)).toBe(true);

    const other = await search(DRAFT_PHRASE, otherTenantId);
    expect(other.every((match) => match.articleId === otherDraft.id)).toBe(true);
    expect(other.some((match) => match.articleId === draft.id)).toBe(false);
  });
});
