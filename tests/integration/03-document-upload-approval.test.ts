// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { runAgent } from "@/core/run";
import { setModelClient, type ModelClient, type ModelRequest, type ModelResult } from "@/core/model";
import { containsUrl } from "@/core/no-urls";
import { search, setEmbeddingProvider, type EmbeddingProvider } from "@/modules/knowledge";
import { GET as searchRoute } from "@/app/api/kb/search/route";
import { POST as uploadRoute } from "@/app/api/kb/documents/route";
import { POST as approveRoute } from "@/app/api/kb/documents/[id]/approve/route";
import { signAccessSession, verifyManagerCode } from "@/modules/access/session";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

import { buildDocx, buildPdf, buildZip } from "../knowledge/document-fixtures";

/**
 * Интеграционная проверка среза 03 «Загрузка, индексация и утверждение
 * документов базы знаний» по критериям приёмки тикета.
 *
 * Команда проверки: `npm run test -- tests/integration/03-document-upload-approval.test.ts`
 *
 * Сценарий целиком: менеджер загружает PDF, DOCX, Markdown и TXT → документы
 * ждут проверки и не видны поиску → менеджер одобряет один из них → тот же
 * вопрос находит чанк, цитату и источник → неподдерживаемый формат
 * отклоняется без следа → сбой разбора оставляет документ в состоянии
 * ошибки → повторное одобрение отклоняется конфликтом.
 *
 * Модель подменяется на границе: реальных ключей у среза нет. Персональных
 * данных и материалов заказчика в тесте нет — документы синтетические.
 */

const TENANT_SLUG = "test-integration-03";
const MANAGER_CODE = "demo-manager-code-03";
const SESSION_SECRET = "demo-test-session-secret-03";
const EMBEDDING_DIMENSIONS = 1536;

/** Провайдер эмбеддингов, совпадающий с детерминированным из `knowledge`. */
const deterministicProvider: EmbeddingProvider = {
  model: "deterministic-hash-v1",
  embed: async (text: string) => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 3) continue;
      const stem = raw.slice(0, 6);
      let hash = 2166136261;
      for (let index = 0; index < stem.length; index += 1) {
        hash ^= stem.charCodeAt(index);
        hash = Math.imul(hash, 16779621);
      }
      const index = Math.abs(hash) % EMBEDDING_DIMENSIONS;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    return vector;
  },
};

/** Синтетический текст документа: реальных данных клиентов в нём нет. */
const DOCUMENT_TEXT = [
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.",
  "Счёт выставляется в течение одного рабочего дня после подписания заявки.",
  "Сроки ответа по заявке на лицензирование составляют не более 48 часов.",
  "Для ускорения ответа укажите в обращении номер договора и версию продукта.",
  "Менеджер подтверждает получение заявки в рабочее время поддержки.",
].join(" ");

const LONG_TEXT = `${DOCUMENT_TEXT} ${DOCUMENT_TEXT} ${DOCUMENT_TEXT}`;

/** Вопрос клиента по содержимому документа. */
const QUESTION = "Какие сроки ответа по заявке на лицензирование?";

/**
 * Модель, которая цитирует источник и добавляет ссылку на него.
 *
 * Ссылка в тексте ответа проверяется отдельно: ядро вычищает URL из клиентского
 * текста, но источник в `answer.sources` и в трассе остаётся.
 */
function citingModel(): ModelClient {
  return {
    complete: async (_request: ModelRequest): Promise<ModelResult> => ({
      text: "Сроки ответа по заявке на лицензирование — не более 48 часов. Подробнее: https://softline.example/kb/licensing",
      amounts: [48],
      citations: ["Сроки ответа по заявке на лицензирование составляют не более 48 часов."],
      tokensIn: 120,
      tokensOut: 60,
      costRub: 0.5,
      model: "stub-model",
    }),
  };
}

/** Модель, отвечающая без источника. */
function emptyModel(): ModelClient {
  return {
    complete: async (_request: ModelRequest): Promise<ModelResult> => ({
      text: "Ответ из памяти модели.",
      amounts: [],
      citations: [],
      tokensIn: 120,
      tokensOut: 60,
      costRub: 0.5,
      model: "stub-model",
    }),
  };
}

/**
 * Подписанная cookie кабинета менеджера.
 *
 * Сессия выдаётся настоящим кодом менеджера: подпись проверяется по коду из
 * окружения, и cookie, собранная вручную, барьер не пройдёт.
 */
async function issueManagerCookie(): Promise<string> {
  const session = await verifyManagerCode(MANAGER_CODE);
  if (session === null) {
    throw new Error("Код менеджера не принят: сессию кабинета не выдать");
  }
  return `support_manager=${signAccessSession(session)}`;
}

describe("03 — загрузка, индексация и утверждение документов базы знаний", () => {
  let tenantId = "";
  let conversationId = "";
  let documentsDir = "";
  let managerCookie = "";

  beforeAll(async () => {
    await ensureSchema();
    documentsDir = await mkdtemp(join(tmpdir(), "kb-upload-integration-"));
    process.env.KB_DOCUMENTS_DIR = documentsDir;
    process.env.MANAGER_ACCESS_CODE = MANAGER_CODE;
    process.env.SESSION_SECRET = SESSION_SECRET;
    setEmbeddingProvider(deterministicProvider);
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
    process.env.TENANT_SLUG = TENANT_SLUG;
    const conversation = await testPool().query<{ id: string }>(
      "INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id",
      [tenantId],
    );
    conversationId = conversation.rows[0]?.id ?? "";
    managerCookie = await issueManagerCookie();
    process.env.ESCALATION_MODE = "off";
  });

  afterAll(async () => {
    await rm(documentsDir, { recursive: true, force: true });
    await closePool();
  });

  /** Загрузка файла через HTTP-маршрут. */
  async function upload(
    filename: string,
    bytes: Buffer,
    contentType = "application/octet-stream",
  ): Promise<Response> {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], filename, { type: contentType }));
    return uploadRoute(
      new Request("http://localhost/api/kb/documents", {
        method: "POST",
        headers: { cookie: managerCookie },
        body: form,
      }),
    );
  }

  /** Одобрение документа через HTTP-маршрут. */
  async function approve(id: string, actor = "manager-1"): Promise<Response> {
    return approveRoute(
      new Request(`http://localhost/api/kb/documents/${id}/approve`, {
        method: "POST",
        headers: { cookie: managerCookie, "content-type": "application/json" },
        body: JSON.stringify({ actor }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("AC 1: менеджер загружает PDF, DOCX, Markdown и TXT — документы ждут проверки", async () => {
    const cases: Array<{ filename: string; bytes: Buffer }> = [
      { filename: "licensing.pdf", bytes: await buildPdf(LONG_TEXT) },
      { filename: "licensing.docx", bytes: buildDocx([LONG_TEXT]) },
      { filename: "licensing.md", bytes: Buffer.from(`# Лицензирование\n\n${LONG_TEXT}`, "utf8") },
      { filename: "licensing.txt", bytes: Buffer.from(LONG_TEXT, "utf8") },
    ];

    for (const item of cases) {
      const response = await upload(item.filename, item.bytes);
      expect(response.status, `${item.filename}: код ответа`).toBe(202);

      const body = (await response.json()) as {
        id: string;
        status: string;
        filename: string;
        mime_type: string;
        chunks_count: number;
      };
      expect(body.status, `${item.filename}: статус`).toBe("pending");
      expect(body.filename).toBe(item.filename);
      expect(body.mime_type).toBeTruthy();
      expect(body.chunks_count, `${item.filename}: число чанков`).toBeGreaterThan(0);

      const document = await testPool().query<{
        status: string;
        parse_status: string;
        chunks_count: number;
        extracted_chars: number;
      }>(
        "SELECT status, parse_status, chunks_count, extracted_chars FROM kb_documents WHERE id = $1",
        [body.id],
      );
      expect(document.rows[0]?.status, `${item.filename}: статус в базе`).toBe("pending");
      expect(document.rows[0]?.parse_status, `${item.filename}: разбор`).toBe("parsed");
      expect(document.rows[0]?.chunks_count, `${item.filename}: чанки`).toBeGreaterThan(0);
      expect(document.rows[0]?.extracted_chars, `${item.filename}: объём текста`).toBeGreaterThan(0);

      const chunks = await testPool().query<{
        embedding: string;
        search_vector: string;
        embedding_model: string;
      }>(
        "SELECT embedding::text AS embedding, search_vector::text AS search_vector, embedding_model FROM kb_chunks WHERE document_id = $1",
        [body.id],
      );
      expect(chunks.rows.length, `${item.filename}: чанки в базе`).toBeGreaterThan(0);
      for (const chunk of chunks.rows) {
        expect(chunk.embedding).not.toBe("");
        expect(chunk.search_vector).not.toBe("");
        expect(chunk.embedding_model).toBe(deterministicProvider.model);
      }
    }
  });

  it("AC 2: неподдерживаемый формат отклоняется, источник не создаётся", async () => {
    const before = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_documents WHERE tenant_id = $1",
      [tenantId],
    );

    const unsupported = [
      { filename: "installer.exe", bytes: Buffer.from("MZ binary", "utf8") },
      { filename: "archive.zip", bytes: buildZip([["note.txt", "hello"]]) },
    ];

    for (const item of unsupported) {
      const response = await upload(item.filename, item.bytes);
      expect(response.status, `${item.filename}: код ответа`).toBe(415);

      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unsupported_media_type");
      expect(body.error.message).toContain("PDF");
      expect(body.error.message).toContain("DOCX");
    }

    const after = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_documents WHERE tenant_id = $1",
      [tenantId],
    );
    const chunks = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_chunks WHERE tenant_id = $1",
      [tenantId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(chunks.rows[0]?.count).toBe("0");
  });

  it("AC 3: до одобрения поиск и агент документ не находят", async () => {
    const response = await upload("pending.txt", Buffer.from(LONG_TEXT, "utf8"), "text/plain");
    const body = (await response.json()) as { id: string };
    setModelClient(emptyModel());

    const matches = await searchRoute(
      new Request(`http://localhost/api/kb/search?q=${encodeURIComponent(QUESTION)}`),
    );
    const searchBody = (await matches.json()) as { matches: Array<{ article_id: string }> };
    expect(searchBody.matches.map((match) => match.article_id)).not.toContain(body.id);

    const outcome = await runAgent({
      conversationId,
      messageId: "44444444-4444-4444-8444-444444444441",
      channel: "web",
      externalChatId: null,
      text: QUESTION,
      maskedFieldsCount: 0,
      tenantId,
    });
    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;
    expect(outcome.answer.text).toContain("нет ответа");
    expect(outcome.answer.sources.map((source) => source.id)).not.toContain(body.id);
  });

  it("AC 4: после одобрения тот же запрос находит чанк, цитату и источник", async () => {
    const response = await upload("approved.txt", Buffer.from(LONG_TEXT, "utf8"), "text/plain");
    const body = (await response.json()) as { id: string };

    const approved = await approve(body.id);
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { status: string };
    expect(approvedBody.status).toBe("published");

    setModelClient(citingModel());
    const outcome = await runAgent({
      conversationId,
      messageId: "44444444-4444-4444-8444-444444444442",
      channel: "web",
      externalChatId: null,
      text: QUESTION,
      maskedFieldsCount: 0,
      tenantId,
    });
    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;

    const source = outcome.answer.sources.find((item) => item.id === body.id);
    expect(source).toBeDefined();
    expect(source?.kind).toBe("kb_document");
    expect(source?.title).toBe("approved.txt");
    expect(source?.text).toContain("Сроки ответа по заявке");
    expect(source?.location).toContain("approved.txt");

    // В клиентском тексте ссылки нет: механизм вычистки URL — общий.
    expect(containsUrl(outcome.answer.text)).toBe(false);
    expect(outcome.answer.text).not.toContain("softline.example");
    expect(outcome.answer.text).toContain("48 часов");

    // Источник виден в трассе агента.
    const retrieve = outcome.steps.find((step) => step.node === "retrieve");
    expect(retrieve?.sourceIds).toContain(body.id);
  });

  it("AC 5: сбой разбора оставляет документ в состоянии ошибки, он не виден поиском", async () => {
    const response = await upload(
      "broken.pdf",
      Buffer.from("%PDF-1.7\nбитый файл без потоков страниц\n", "latin1"),
      "application/pdf",
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { id: string; status: string };

    const document = await testPool().query<{
      status: string;
      parse_status: string;
      parse_error: string | null;
    }>("SELECT status, parse_status, parse_error FROM kb_documents WHERE id = $1", [body.id]);
    expect(document.rows[0]?.status).toBe("error");
    expect(document.rows[0]?.parse_status).toBe("failed");
    expect(document.rows[0]?.parse_error).toBeTruthy();

    const results = await search(QUESTION, tenantId);
    expect(results.map((result) => result.articleId)).not.toContain(body.id);

    // Материал виден менеджеру: он остался в базе.
    const visible = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_documents WHERE tenant_id = $1 AND id = $2",
      [tenantId, body.id],
    );
    expect(visible.rows[0]?.count).toBe("1");
  });

  it("AC 6: непубличные состояния не попадают в выдачу, параметры запроса не помогают", async () => {
    const response = await upload("states.txt", Buffer.from(LONG_TEXT, "utf8"), "text/plain");
    const body = (await response.json()) as { id: string };

    for (const status of ["pending", "error", "rejected"] as const) {
      await testPool().query("UPDATE kb_documents SET status = $2 WHERE id = $1", [
        body.id,
        status,
      ]);
      const results = await search(QUESTION, tenantId);
      expect(
        results.map((result) => result.articleId),
        `состояние ${status}`,
      ).not.toContain(body.id);
    }

    // Прямые параметры запроса результата не меняют.
    const withParams = await searchRoute(
      new Request(
        `http://localhost/api/kb/search?q=${encodeURIComponent(QUESTION)}&status=pending&include_pending=1&document_id=${body.id}`,
      ),
    );
    const paramsBody = (await withParams.json()) as {
      matches: Array<{ article_id: string }>;
    };
    expect(paramsBody.matches.map((match) => match.article_id)).not.toContain(body.id);
  });

  it("безопасность: без cookie менеджера загрузка и одобрение не проходят", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(Buffer.from(LONG_TEXT, "utf8"))], "x.txt"));

    const anonymousUpload = await uploadRoute(
      new Request("http://localhost/api/kb/documents", {
        method: "POST",
        body: form,
      }),
    );
    expect(anonymousUpload.status).toBe(401);

    const anonymousApprove = await approveRoute(
      new Request("http://localhost/api/kb/documents/11111111-1111-4111-8111-111111111111/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "manager-1" }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );
    expect(anonymousApprove.status).toBe(401);
  });

  it("безопасность: чужой документ не одобряется и не находится", async () => {
    const response = await upload("foreign.txt", Buffer.from(LONG_TEXT, "utf8"), "text/plain");
    const body = (await response.json()) as { id: string };

    await testPool().query(
      "UPDATE kb_documents SET tenant_id = (SELECT id FROM tenants WHERE slug = 'demo-tenant') WHERE id = $1",
      [body.id],
    );

    const approved = await approve(body.id);
    expect(approved.status).toBe(404);
    const errorBody = (await approved.json()) as { error: { code: string } };
    expect(errorBody.error.code).toBe("not_found");

    const results = await search(QUESTION, tenantId);
    expect(results.map((result) => result.articleId)).not.toContain(body.id);
  });

  it("повторное одобрение отклоняется конфликтом", async () => {
    const response = await upload("twice.txt", Buffer.from(LONG_TEXT, "utf8"), "text/plain");
    const body = (await response.json()) as { id: string };

    const first = await approve(body.id);
    expect(first.status).toBe(200);

    const second = await approve(body.id);
    expect(second.status).toBe(409);
    const errorBody = (await second.json()) as { error: { code: string } };
    expect(errorBody.error.code).toBe("conflict");
  });
});
