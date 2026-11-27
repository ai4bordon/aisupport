// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { runAgent } from "@/core/run";
import { setModelClient, type ModelClient, type ModelRequest, type ModelResult } from "@/core/model";
import { containsUrl } from "@/core/no-urls";
import { search, setEmbeddingProvider, type EmbeddingProvider } from "@/modules/knowledge";
import { GET } from "@/app/api/kb/search/route";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Одобрение документа и ответ агента по нему.
 *
 * Шаги 5 и 6 плана среза 03: после одобрения тот же вопрос находит чанки
 * документа, агент отвечает с цитатой и источником, а URL не попадает в
 * клиентский текст. До одобрения тот же вопрос не находит ничего.
 *
 * Модель подменяется на границе: реальные ключи у среза нет, поэтому
 * проверяется поведение ядра, а не живой вызов провайдера.
 */
import {
  KnowledgeDocumentError,
  approveDocument,
  rejectDocument,
  retryDocumentParse,
  uploadDocument,
} from "@/modules/document-upload";

const TENANT_SLUG = "test-document-approval";
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
        hash = Math.imul(hash, 16777619);
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
      text: `Сроки ответа по заявке на лицензирование — не более 48 часов. Подробнее: https://softline.example/kb/licensing`,
      amounts: [48],
      citations: ["Сроки ответа по заявке на лицензирование составляют не более 48 часов."],
      tokensIn: 120,
      tokensOut: 60,
      costRub: 0.5,
      model: "stub-model",
    }),
  };
}

/** Модель, которая отвечает без источника. */
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

describe("одобрение документа и ответ агента", () => {
  let tenantId = "";
  let conversationId = "";
  let documentsDir = "";

  beforeAll(async () => {
    await ensureSchema();
    documentsDir = await mkdtemp(join(tmpdir(), "kb-upload-approval-"));
    process.env.KB_DOCUMENTS_DIR = documentsDir;
    setEmbeddingProvider(deterministicProvider);
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
    const conversation = await testPool().query<{ id: string }>(
      "INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id",
      [tenantId],
    );
    conversationId = conversation.rows[0]?.id ?? "";
    process.env.ESCALATION_MODE = "off";
  });

  afterAll(async () => {
    await rm(documentsDir, { recursive: true, force: true });
    await closePool();
  });

  async function uploadPending(filename = "licensing.txt"): Promise<string> {
    const record = await uploadDocument({
      tenantId,
      filename,
      mimeType: "text/plain",
      bytes: Buffer.from(LONG_TEXT, "utf8"),
      uploadedBy: "manager-1",
    });
    expect(record.status).toBe("pending");
    return record.id;
  }

  it("до одобрения агент не находит документ и отвечает, что его нет в базе", async () => {
    const documentId = await uploadPending();
    setModelClient(emptyModel());

    const outcome = await runAgent({
      conversationId,
      messageId: "33333333-3333-4333-8333-333333333331",
      channel: "web",
      externalChatId: null,
      text: QUESTION,
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;
    // Клиенту сообщается об отсутствии точного ответа; где именно агент
    // искал, в тексте не упоминается.
    expect(outcome.answer.text).toContain("нет точного ответа");
    expect(outcome.answer.text).not.toMatch(/баз[ае] знаний/i);
    expect(outcome.answer.sources.map((source) => source.id)).not.toContain(documentId);

    const retrieve = outcome.steps.find((step) => step.node === "retrieve");
    expect(retrieve?.sourceIds).not.toContain(documentId);
  });

  it("после одобрения тот же вопрос находит чанки документа", async () => {
    const documentId = await uploadPending("approved.txt");
    await approveDocument(tenantId, documentId, "manager-1");

    const results = await search(QUESTION, tenantId);
    const found = results.find((result) => result.articleId === documentId);

    expect(found).toBeDefined();
    expect(found?.kind).toBe("kb_document");
    expect(found?.title).toBe("approved.txt");
    expect(found?.text).toContain("Сроки ответа по заявке");
    expect(found?.location).toContain("approved.txt");
  });

  it("после одобрения агент отвечает с цитатой и источником, а URL не уходит клиенту", async () => {
    const documentId = await uploadPending("cited.txt");
    await approveDocument(tenantId, documentId, "manager-1");
    setModelClient(citingModel());

    const outcome = await runAgent({
      conversationId,
      messageId: "33333333-3333-4333-8333-333333333332",
      channel: "web",
      externalChatId: null,
      text: QUESTION,
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;

    // Источник виден клиенту отдельно от текста ответа.
    const source = outcome.answer.sources.find((item) => item.id === documentId);
    expect(source).toBeDefined();
    expect(source?.kind).toBe("kb_document");
    expect(source?.title).toBe("cited.txt");
    expect(source?.location).toBeTruthy();

    // В тексте ответа ссылки нет: механизм вычистки URL — общий.
    expect(containsUrl(outcome.answer.text)).toBe(false);
    expect(outcome.answer.text).not.toContain("softline.example");
    expect(outcome.answer.text).toContain("48 часов");
  });

  it("источник виден в трассе агента", async () => {
    const documentId = await uploadPending("traced.txt");
    await approveDocument(tenantId, documentId, "manager-1");
    setModelClient(citingModel());

    const outcome = await runAgent({
      conversationId,
      messageId: "33333333-3333-4333-8333-333333333333",
      channel: "web",
      externalChatId: null,
      text: QUESTION,
      maskedFieldsCount: 0,
      tenantId,
    });

    expect(outcome.outcome).toBe("respond");
    if (outcome.outcome !== "respond") return;

    const retrieve = outcome.steps.find((step) => step.node === "retrieve");
    expect(retrieve?.sourceIds).toContain(documentId);
  });

  it("повторное одобрение отклоняется конфликтом", async () => {
    const documentId = await uploadPending("twice.txt");
    await approveDocument(tenantId, documentId, "manager-1");

    await expect(approveDocument(tenantId, documentId, "manager-2")).rejects.toBeInstanceOf(
      KnowledgeDocumentError,
    );

    try {
      await approveDocument(tenantId, documentId, "manager-2");
      throw new Error("повторное одобрение должно отклоняться");
    } catch (error) {
      expect(error).toBeInstanceOf(KnowledgeDocumentError);
      expect((error as KnowledgeDocumentError).code).toBe("conflict");
    }
  });

  it("документ чужого арендатора не одобряется и не находится", async () => {
    const documentId = await uploadPending("foreign.txt");

    await testPool().query(
      "UPDATE kb_documents SET tenant_id = (SELECT id FROM tenants WHERE slug = 'demo-tenant') WHERE id = $1",
      [documentId],
    );

    await expect(approveDocument(tenantId, documentId, "manager-1")).rejects.toBeInstanceOf(
      KnowledgeDocumentError,
    );

    const results = await search(QUESTION, tenantId);
    expect(results.map((result) => result.articleId)).not.toContain(documentId);
  });

  it("непубличные состояния документа не попадают в выдачу", async () => {
    const documentId = await uploadPending("states.txt");

    for (const status of ["pending", "error", "rejected"] as const) {
      await testPool().query("UPDATE kb_documents SET status = $2 WHERE id = $1", [
        documentId,
        status,
      ]);
      const results = await search(QUESTION, tenantId);
      expect(
        results.map((result) => result.articleId),
        `состояние ${status}`,
      ).not.toContain(documentId);
    }

    await testPool().query(
      "UPDATE kb_documents SET status = 'published' WHERE id = $1",
      [documentId],
    );
    const published = await search(QUESTION, tenantId);
    expect(published.map((result) => result.articleId)).toContain(documentId);
  });

  it("сбой разбора оставляет документ в состоянии ошибки, и он не виден поиску", async () => {
    // Документ с испорченным содержимым: расширение поддерживаемое, а сигнатура
    // документа соответствует формату, но сам текст разобрать нельзя.
    const record = await uploadDocument({
      tenantId,
      filename: "broken.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nбитый файл без потоков страниц\n", "latin1"),
      uploadedBy: "manager-1",
    });

    expect(record.status).toBe("error");
    expect(record.parseStatus).toBe("failed");
    expect(record.parseError).toBeTruthy();
    expect(record.parseError).not.toContain("at ");

    const results = await search(QUESTION, tenantId);
    expect(results.map((result) => result.articleId)).not.toContain(record.id);

    const list = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_documents WHERE tenant_id = $1 AND id = $2",
      [tenantId, record.id],
    );
    expect(list.rows[0]?.count).toBe("1");
  });

  it("ошибка индексации оставляет документ в состоянии ошибки и не в поиске", async () => {
    const failingProvider: EmbeddingProvider = {
      model: "failing-model-v1",
      embed: async () => {
        throw new Error("провайдер эмбеддингов недоступен");
      },
    };

    const record = await uploadDocument(
      {
        tenantId,
        filename: "index-failed.txt",
        mimeType: "text/plain",
        bytes: Buffer.from(LONG_TEXT, "utf8"),
        uploadedBy: "manager-1",
      },
      { embeddingProvider: failingProvider },
    );

    expect(record.status).toBe("error");
    expect(record.parseStatus).toBe("failed");
    expect(record.parseError).toContain("провайдер эмбеддингов недоступен");

    const results = await search(QUESTION, tenantId);
    expect(results.map((result) => result.articleId)).not.toContain(record.id);
  });

  it("повторная попытка на исправном файле возвращает документ в pending", async () => {
    const record = await uploadDocument({
      tenantId,
      filename: "retry.txt",
      mimeType: "text/plain",
      bytes: Buffer.from(LONG_TEXT, "utf8"),
      uploadedBy: "manager-1",
    });

    // Документ уводится в состояние ошибки: так выглядит материал, который
    // не удалось разобрать.
    await testPool().query(
      "UPDATE kb_documents SET status = 'error', parse_status = 'failed', parse_error = 'сбой' WHERE id = $1",
      [record.id],
    );

    const retried = await retryDocumentParse(tenantId, record.id);

    expect(retried.status).toBe("pending");
    expect(retried.parseStatus).toBe("parsed");
    expect(retried.parseError).toBeNull();
    expect(retried.retryCount).toBeGreaterThan(0);
    expect(retried.chunksCount).toBeGreaterThan(0);

    const chunks = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_chunks WHERE document_id = $1",
      [record.id],
    );
    expect(Number(chunks.rows[0]?.count ?? "0")).toBe(retried.chunksCount);

    await approveDocument(tenantId, record.id, "manager-1");
    const results = await search(QUESTION, tenantId);
    expect(results.map((result) => result.articleId)).toContain(record.id);
  });

  it("отклонённый документ поиском не выдаётся", async () => {
    const documentId = await uploadPending("rejected.txt");
    await rejectDocument(tenantId, documentId, "manager-1", "неактуально");

    const results = await search(QUESTION, tenantId);
    expect(results.map((result) => result.articleId)).not.toContain(documentId);
  });

  it("обе ветви выдачи используют один allowlist опубликованных источников", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/modules/knowledge/search.ts"),
      "utf8",
    );

    // Условие допуска задано один раз и используется обеими ветвями: в
    // векторной и в полнотекстовой. Раздельные условия расходятся при правке.
    const occurrences = source.split("a.status = 'published'").length - 1;
    expect(occurrences).toBe(1);
    expect(source).toContain("PUBLISHED_SOURCE_PREDICATE");

    // Векторная и полнотекстовая ветви ссылаются на общий фрагмент.
    const uses = source.split("${PUBLISHED_SOURCE_PREDICATE}").length - 1;
    expect(uses).toBe(2);
  });

  it("маршрут поиска не читает параметры, раскрывающие статус", async () => {
    const route = await readFile(
      resolve(process.cwd(), "src/app/api/kb/search/route.ts"),
      "utf8",
    );

    // Параметры запроса не могут раскрыть ожидающий контент: маршрут их не
    // читает, а публичный поиск таких параметров не принимает.
    expect(route).not.toContain('searchParams.get("status")');
    expect(route).not.toContain('searchParams.get("include_pending")');
    expect(route).not.toContain('searchParams.get("document_id")');
    expect(route).not.toContain("include_pending");
    expect(route).not.toContain("document_id");
  });

  it("прямые параметры запроса не раскрывают ожидающий документ", async () => {
    const documentId = await uploadPending("guarded.txt");

    const response = await GET(
      new Request(
        `http://localhost/api/kb/search?q=${encodeURIComponent(QUESTION)}&status=pending&include_pending=1&document_id=${documentId}`,
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { matches: Array<{ article_id: string }> };
    expect(body.matches.map((match) => match.article_id)).not.toContain(documentId);
  });
});
