// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closePool } from "@/db/pool";
import { search, setEmbeddingProvider, type EmbeddingProvider } from "@/modules/knowledge";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";
import { buildDocx, buildPdf, buildZip } from "./document-fixtures";

/**
 * Загрузка документов базы знаний: форматы, индексация и отказ по формату.
 *
 * Шаги 2 и 3 плана среза 03. Эмбеддинги детерминированные: внешний API
 * векторов в тестах не вызывается, а модель индекса совпадает с моделью
 * запроса — иначе поиск отверг бы чанк как проиндексированный другой
 * моделью.
 *
 * Тест работает на своём арендаторе: файлы тестов идут последовательно, но
 * делят общую базу, и чужие строки затирать нельзя.
 */

/** Модуль загрузки отсутствует до реализации среза — импорт падает здесь. */
import {
  KnowledgeDocumentError,
  approveDocument,
  getDocument,
  listDocuments,
  uploadDocument,
} from "@/modules/document-upload";

const TENANT_SLUG = "test-document-upload";
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Провайдер эмбеддингов, повторяющий детерминированный: слова приводятся к
 * основе в шесть знаков и раскладываются по хешу.
 */
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

/** Синтетический текст документа: длиннее минимального размера чанка. */
const DOCUMENT_TEXT = [
  "Электронная лицензия предоставляется в течение 120 минут после оплаты.",
  "Счёт выставляется в течение одного рабочего дня после подписания заявки.",
  "Документы для закрывающих материалов принимаются в электронном виде.",
  "Сроки ответа по заявке на лицензирование составляют не более 48 часов.",
  "Для ускорения ответа укажите в обращении номер договора и версию продукта.",
  "Менеджер подтверждает получение заявки в рабочее время поддержки.",
].join(" ");

const LONG_TEXT = `${DOCUMENT_TEXT} ${DOCUMENT_TEXT} ${DOCUMENT_TEXT}`;

/** Уникальная фраза документа: по ней проверяется видимость в поиске. */
const UNIQUE_PHRASE = "Сроки ответа по заявке на лицензирование";

describe("загрузка документов базы знаний", () => {
  let tenantId = "";
  let storageDir = "";
  let documentsDir = "";

  beforeAll(async () => {
    await ensureSchema();
    storageDir = await mkdtemp(join(tmpdir(), "kb-upload-storage-"));
    documentsDir = await mkdtemp(join(tmpdir(), "kb-upload-docs-"));
    process.env.KB_DOCUMENTS_DIR = documentsDir;
    setEmbeddingProvider(deterministicProvider);
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
    await rm(documentsDir, { recursive: true, force: true });
    await closePool();
  });

  it("принимает PDF, DOCX, Markdown и TXT: документ ждёт проверки, чанки проиндексированы", async () => {
    const cases: Array<{ filename: string; bytes: Buffer }> = [
      { filename: "licensing.pdf", bytes: await buildPdf(LONG_TEXT) },
      { filename: "licensing.docx", bytes: buildDocx([LONG_TEXT]) },
      { filename: "licensing.md", bytes: Buffer.from(`# Лицензирование\n\n${LONG_TEXT}`, "utf8") },
      { filename: "licensing.txt", bytes: Buffer.from(LONG_TEXT, "utf8") },
    ];

    for (const item of cases) {
      const record = await uploadDocument({
        tenantId,
        filename: item.filename,
        mimeType: "application/octet-stream",
        bytes: item.bytes,
        uploadedBy: "manager-1",
      });

      expect(record.status, `${item.filename}: статус (${record.parseError ?? "без ошибки"})`).toBe("pending");
      expect(record.parseStatus, `${item.filename}: разбор`).toBe("parsed");
      expect(record.parseError, `${item.filename}: ошибка разбора`).toBeNull();
      expect(record.chunksCount, `${item.filename}: число чанков`).toBeGreaterThan(0);
      expect(record.extractedChars, `${item.filename}: объём текста`).toBeGreaterThan(0);
      expect(record.sourceKind).toBe("manager_upload");
      expect(record.snapshotHash).toMatch(/^[0-9a-f]{64}$/u);

      const chunks = await testPool().query<{
        chunk_no: number;
        text: string;
        embedding: string;
        search_vector: string;
        embedding_model: string;
      }>(
        `SELECT chunk_no, text, embedding::text AS embedding, search_vector::text AS search_vector, embedding_model
         FROM kb_chunks WHERE tenant_id = $1 AND document_id = $2 ORDER BY chunk_no`,
        [tenantId, record.id],
      );

      expect(chunks.rows.length, `${item.filename}: чанки в базе`).toBe(record.chunksCount);
      for (const chunk of chunks.rows) {
        expect(chunk.embedding, `${item.filename}: вектор`).not.toBe("");
        expect(chunk.search_vector, `${item.filename}: полнотекстовый вектор`).not.toBe("");
        expect(chunk.embedding_model, `${item.filename}: модель вектора`).toBe(
          deterministicProvider.model,
        );
        expect(chunk.text).toContain("Источник:");
        expect(chunk.text).toContain(item.filename);
      }
    }
  });

  it("до одобрения документ не выдаётся поиском", async () => {
    const record = await uploadDocument({
      tenantId,
      filename: "hidden.txt",
      mimeType: "text/plain",
      bytes: Buffer.from(LONG_TEXT, "utf8"),
      uploadedBy: "manager-1",
    });

    const results = await search(UNIQUE_PHRASE, tenantId);

    expect(results.map((result) => result.articleId)).not.toContain(record.id);
    expect(results.map((result) => result.text).join(" ")).not.toContain(UNIQUE_PHRASE);
  });

  it("документ другого арендатора не попадает в выдачу", async () => {
    // Арендатор другого слоя создаётся заново: `resetTenant` удаляет только
    // строки текущего, а чужой арендатор из прошлого прогона мог бы остаться.
    await testPool().query(
      `DELETE FROM kb_chunks WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-document-upload-other')`,
    );
    await testPool().query(
      `DELETE FROM kb_documents WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-document-upload-other')`,
    );
    await testPool().query(
      "DELETE FROM tenants WHERE slug = 'test-document-upload-other'",
    );
    const other = await testPool().query<{ id: string }>(
      "INSERT INTO tenants (slug, name) VALUES ('test-document-upload-other', 'Другой') RETURNING id",
    );
    const otherTenantId = other.rows[0]?.id ?? "";

    const record = await uploadDocument({
      tenantId,
      filename: "mine.txt",
      mimeType: "text/plain",
      bytes: Buffer.from(LONG_TEXT, "utf8"),
      uploadedBy: "manager-1",
    });

    const foreign = await testPool().query<{ id: string }>(
      `INSERT INTO kb_documents (tenant_id, filename, mime_type, size_bytes, storage_path, status, parse_status)
       VALUES ($1, 'foreign.txt', 'text/plain', 100, '/tmp/foreign.txt', 'published', 'parsed')
       RETURNING id`,
      [otherTenantId],
    );

    await testPool().query(
      `INSERT INTO kb_chunks (tenant_id, document_id, chunk_no, text, search_vector, embedding, embedding_model)
       VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, $5)`,
      [
        otherTenantId,
        foreign.rows[0]?.id ?? "",
        LONG_TEXT,
        `[${new Array(EMBEDDING_DIMENSIONS).fill(0).join(",")}]`,
        deterministicProvider.model,
      ],
    );

    const results = await search(UNIQUE_PHRASE, tenantId);

    expect(results.map((result) => result.articleId)).not.toContain(record.id);
    expect(results.map((result) => result.articleId)).not.toContain(foreign.rows[0]?.id);
    expect(results).toEqual([]);
  });

  it("неподдерживаемое расширение отклоняется и не оставляет следа", async () => {
    const before = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_documents WHERE tenant_id = $1",
      [tenantId],
    );
    const filesBefore = await readdir(documentsDir);

    const unsupported = [
      { filename: "installer.exe", bytes: Buffer.from("MZ binary", "utf8") },
      { filename: "archive.zip", bytes: buildZip([["note.txt", "hello"]]) },
      { filename: "legacy.doc", bytes: Buffer.from("old word", "utf8") },
      { filename: "no-extension", bytes: Buffer.from(LONG_TEXT, "utf8") },
    ];

    for (const item of unsupported) {
      await expect(
        uploadDocument({
          tenantId,
          filename: item.filename,
          mimeType: "application/octet-stream",
          bytes: item.bytes,
          uploadedBy: "manager-1",
        }),
      ).rejects.toBeInstanceOf(KnowledgeDocumentError);

      try {
        await uploadDocument({
          tenantId,
          filename: item.filename,
          mimeType: "application/octet-stream",
          bytes: item.bytes,
          uploadedBy: "manager-1",
        });
        throw new Error("загрузка неподдерживаемого формата должна отклоняться");
      } catch (error) {
        expect(error).toBeInstanceOf(KnowledgeDocumentError);
        const domain = error as KnowledgeDocumentError;
        expect(domain.code).toBe("unsupported_media_type");
        expect(domain.message).toContain("PDF");
        expect(domain.message).toContain("DOCX");
        expect(domain.message).toContain("Markdown");
        expect(domain.message).toContain("TXT");
      }
    }

    const after = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_documents WHERE tenant_id = $1",
      [tenantId],
    );
    const chunks = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_chunks WHERE tenant_id = $1",
      [tenantId],
    );
    const filesAfter = await readdir(documentsDir);

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(chunks.rows[0]?.count).toBe("0");
    expect(filesAfter).toEqual(filesBefore);
  });

  it("неподдерживаемое расширение отклоняется до разбора", async () => {
    const parse = await import("@/modules/document-upload/parse");
    const spy = vi.spyOn(parse, "parseDocument");

    try {
      await expect(
        uploadDocument({
          tenantId,
          filename: "installer.exe",
          mimeType: "application/octet-stream",
          bytes: await buildPdf(LONG_TEXT),
          uploadedBy: "manager-1",
        }),
      ).rejects.toBeInstanceOf(KnowledgeDocumentError);
    } finally {
      spy.mockRestore();
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it("содержимое, не совпадающее с расширением, отклоняется", async () => {
    const mismatched: Array<{ filename: string; bytes: Buffer }> = [
      // PDF под именем текстового документа.
      { filename: "report.txt", bytes: await buildPdf(LONG_TEXT) },
      // Текст под именем PDF.
      { filename: "report.pdf", bytes: Buffer.from(LONG_TEXT, "utf8") },
      // Обычный архив под именем документа Word.
      { filename: "report.docx", bytes: buildZip([["note.txt", "hello"]]) },
    ];

    for (const item of mismatched) {
      try {
        await uploadDocument({
          tenantId,
          filename: item.filename,
          mimeType: "application/octet-stream",
          bytes: item.bytes,
          uploadedBy: "manager-1",
        });
        throw new Error(`«${item.filename}» не должен приниматься`);
      } catch (error) {
        expect(error).toBeInstanceOf(KnowledgeDocumentError);
        expect((error as KnowledgeDocumentError).code).toBe("unsupported_media_type");
      }
    }

    const documents = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kb_documents WHERE tenant_id = $1",
      [tenantId],
    );
    expect(documents.rows[0]?.count).toBe("0");
  });

  it("загруженный документ виден менеджеру в списке", async () => {
    const record = await uploadDocument({
      tenantId,
      filename: "visible.txt",
      mimeType: "text/plain",
      bytes: Buffer.from(LONG_TEXT, "utf8"),
      uploadedBy: "manager-1",
    });

    const list = await listDocuments(tenantId, {});
    const found = list.find((item) => item.id === record.id);

    expect(found).toBeDefined();
    expect(found?.status).toBe("pending");
    expect(found?.chunksCount).toBeGreaterThan(0);

    const loaded = await getDocument(tenantId, record.id);
    expect(loaded?.id).toBe(record.id);
    expect(loaded?.filename).toBe("visible.txt");
  });

  it("одобрение переводит документ в published и открывает его поиску", async () => {
    const record = await uploadDocument({
      tenantId,
      filename: "approved.txt",
      mimeType: "text/plain",
      bytes: Buffer.from(LONG_TEXT, "utf8"),
      uploadedBy: "manager-1",
    });

    const approved = await approveDocument(tenantId, record.id, "manager-1");

    expect(approved.status).toBe("published");
    expect(approved.approvedBy).toBe("manager-1");

    const results = await search(UNIQUE_PHRASE, tenantId);
    const found = results.find((result) => result.articleId === record.id);

    expect(found).toBeDefined();
    expect(found?.kind).toBe("kb_document");
    expect(found?.title).toBe("approved.txt");
    expect(found?.location).toContain("approved.txt");
  });
});
