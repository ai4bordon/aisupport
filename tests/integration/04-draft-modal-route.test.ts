import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { createArticleDraft, approveArticleDraft, publishArticleDraft } from "@/modules/article-drafts";
import { signAccessSession, verifyAccessCode } from "@/modules/access/session";
import {
  GET,
  PUT,
  DELETE,
} from "@/app/api/manager/knowledge/draft/[id]/route";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Маршрут черновика в кабинете менеджера: чтение, правка и удаление.
 *
 * Команда проверки: npm run test -- tests/integration/04-draft-modal-route.test.ts
 *
 * Менеджер открывает черновик целиком: в списке видны только выдержка и
 * заголовок, а полный текст статьи лежит в маршруте черновика.
 */

const TENANT_SLUG = "test-integration-04-draft-route";

const ACCESS_CODE = "stand-code-04-route";
const SESSION_SECRET = "test-session-secret-04-route";

/** Текст статьи: длиннее одного предложения, как и настоящий материал. */
const ARTICLE_BODY = [
  "Квота обновления лицензии продлевается автоматически после оплаты.",
  "Продление занимает до пятнадцати минут и не требует отдельной заявки.",
  "Если срок действия лицензии закончился, продление не выполняется.",
].join(" ");

let tenantId = "";

/** Значение cookie доступа: подписанная сессия менеджера. */
async function accessCookie(): Promise<string> {
  const session = await verifyAccessCode(ACCESS_CODE);
  if (!session) throw new Error("Сессия доступа не выдана");
  return `support_access=${signAccessSession(session)}`;
}

/** Диалог с сообщением: материал статьи ссылается на него. */
async function seedDialog(
  forTenantId: string = tenantId,
): Promise<{ conversationId: string; messageIds: string[] }> {
  const conversation = await testPool().query<{ id: string }>(
    "INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id",
    [forTenantId],
  );
  const conversationId = conversation.rows[0]?.id ?? "";
  const message = await testPool().query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, role, text_masked)
     VALUES ($1, $2, gen_random_uuid(), 'client', 'Квота обновления лицензии продлевается автоматически')
     RETURNING id`,
    [forTenantId, conversationId],
  );
  return { conversationId, messageIds: [message.rows[0]?.id ?? ""] };
}

/** Готовый черновик: материал ждёт решения менеджера. */
async function seedDraft(forTenantId: string = tenantId): Promise<string> {
  const dialog = await seedDialog(forTenantId);
  const draft = await createArticleDraft({
    tenantId: forTenantId,
    actor: "manager-1",
    conversationId: dialog.conversationId,
    sourceMessageIds: dialog.messageIds,
    sourceExcerpt: "Квота обновления лицензии продлевается автоматически",
    title: "Продление квоты лицензии",
    bodyMd: ARTICLE_BODY,
  });
  return draft.id;
}

/**
 * Чужой арендатор.
 *
 * Создаётся напрямую, а не через `resetTenant`: тот переключает переменную
 * окружения `TENANT_SLUG`, а маршрут берёт арендатора именно из неё.
 */
async function otherTenantId(): Promise<string> {
  const created = await testPool().query<{ id: string }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
    [
      `test-integration-04-route-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      "Чужой арендатор",
    ],
  );
  return created.rows[0]?.id ?? "";
}

describe("маршрут черновика кабинета менеджера", () => {
  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.ACCESS_CODE = ACCESS_CODE;
    await ensureSchema();
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
  });

  afterAll(async () => {
    await closePool();
  });

  it("GET отдаёт полный текст статьи, а не только выдержку", async () => {
    const id = await seedDraft();
    const cookie = await accessCookie();

    const response = await GET(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        headers: { cookie },
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      draft: { id: string; title: string; body_md: string; status: string };
    };
    expect(body.draft.id).toBe(id);
    expect(body.draft.title).toBe("Продление квоты лицензии");
    // Полный текст, а не выдержка из источника.
    expect(body.draft.body_md).toBe(ARTICLE_BODY);
    expect(body.draft.body_md.length).toBeGreaterThan(
      "Квота обновления лицензии продлевается автоматически".length,
    );
  });

  it("GET закрыт барьером доступа", async () => {
    const id = await seedDraft();

    const response = await GET(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(401);
  });

  it("GET чужого черновика отвечает 404", async () => {
    const id = await seedDraft(await otherTenantId());
    const cookie = await accessCookie();

    const response = await GET(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        headers: { cookie },
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(404);
  });

  it("PUT меняет текст статьи и увеличивает версию", async () => {
    const id = await seedDraft();
    const cookie = await accessCookie();
    const edited = "Новый текст статьи: квота продлевается вручную через кабинет.";

    const before = await testPool().query<{ version: number }>(
      "SELECT version FROM kb_articles WHERE id = $1",
      [id],
    );

    const response = await PUT(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ body_md: edited, version: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      draft: { body_md: string; version: number };
    };
    expect(body.draft.body_md).toBe(edited);

    const after = await testPool().query<{ version: number; body_md: string }>(
      "SELECT version, body_md FROM kb_articles WHERE id = $1",
      [id],
    );
    expect(after.rows[0]?.body_md).toBe(edited);
    // Версия растёт: правка видна по номеру, как и у документа.
    expect(after.rows[0]?.version).toBe((before.rows[0]?.version ?? 1) + 1);
  });

  it("PUT отклоняет пустой текст", async () => {
    const id = await seedDraft();
    const cookie = await accessCookie();

    const response = await PUT(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ body_md: "   ", version: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(400);
  });

  it("DELETE удаляет черновик, и он исчезает из списка", async () => {
    const id = await seedDraft();
    const cookie = await accessCookie();

    const response = await DELETE(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "DELETE",
        headers: { cookie },
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(200);

    const rows = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_articles WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    );
    expect(Number(rows.rows[0]?.count ?? "0")).toBe(0);
  });

  it("DELETE чужого черновика отвечает 404 и ничего не удаляет", async () => {
    const id = await seedDraft(await otherTenantId());
    const cookie = await accessCookie();

    const response = await DELETE(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "DELETE",
        headers: { cookie },
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(404);

    const rows = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_articles WHERE id = $1",
      [id],
    );
    expect(Number(rows.rows[0]?.count ?? "0")).toBe(1);
  });

  it("PUT по устаревшей версии отвечает 409 и не затирает чужую правку", async () => {
    // Поздний менеджер: он открыл материал в версии 1, пока другой
    // менеджер сохранил правку и поднял версию до 2.
    const id = await seedDraft();
    const cookie = await accessCookie();

    const first = await PUT(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ body_md: "Правка первого менеджера.", version: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(first.status).toBe(200);

    const stale = await PUT(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ body_md: "Правка второго менеджера.", version: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(stale.status).toBe(409);

    // Чужая правка на месте: её не затёрли.
    const rows = await testPool().query<{ body_md: string; version: number }>(
      "SELECT body_md, version FROM kb_articles WHERE id = $1",
      [id],
    );
    expect(rows.rows[0]?.body_md).toBe("Правка первого менеджера.");
    expect(rows.rows[0]?.version).toBe(2);
  });

  it("PUT без версии отвечает 400", async () => {
    const id = await seedDraft();
    const cookie = await accessCookie();

    const response = await PUT(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ body_md: "Правка без версии." }),
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(400);
  });

  it("одобренный материал править нельзя: обход ревью закрыт", async () => {
    // Правка одобренного материала опубликовала бы другой текст без
    // нового решения менеджера.
    const id = await seedDraft();
    const cookie = await accessCookie();
    await approveArticleDraft({ tenantId, id, actor: "manager-1" });

    const response = await PUT(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ body_md: "Правка после одобрения.", version: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(409);

    const rows = await testPool().query<{ body_md: string }>(
      "SELECT body_md FROM kb_articles WHERE id = $1",
      [id],
    );
    expect(rows.rows[0]?.body_md).toBe(ARTICLE_BODY);
  });

  it("DELETE опубликованного материала отвечает 409 и не удаляет его", async () => {
    const id = await seedDraft();
    const cookie = await accessCookie();
    await approveArticleDraft({ tenantId, id, actor: "manager-1" });
    await publishArticleDraft({ tenantId, id });

    const response = await DELETE(
      new Request(`http://localhost/api/manager/knowledge/draft/${id}`, {
        method: "DELETE",
        headers: { cookie },
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(409);

    const rows = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_articles WHERE id = $1",
      [id],
    );
    expect(Number(rows.rows[0]?.count ?? "0")).toBe(1);
  });
});
