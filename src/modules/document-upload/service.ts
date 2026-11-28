import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPool } from "@/db/pool";
import { selectIndexableChunks, type Chunk } from "@/import/knowledge";
import { currentEmbeddingProvider } from "@/modules/knowledge";

import { chunkDocument } from "./chunking";
import { KnowledgeDocumentError } from "./errors";
import { detectFormat, mimeTypeFor, parseDocument } from "./parse";
import {
  deleteChunks,
  findDocument,
  findDocuments,
  insertChunks,
  insertDocument,
  markFailed,
  markParsed,
  markPublished,
  markRejected,
} from "./repository";
import type {
  DocumentEmbeddingProvider,
  DocumentFilter,
  DocumentRecord,
  DocumentUploadInput,
  DocumentUploadOptions,
  SupportedDocumentFormat,
} from "./types";

/**
 * Поток загрузки документов базы знаний.
 *
 * Путь материала: определить формат → сохранить файл → создать запись →
 * разобрать → нарезать → проиндексировать → ждать одобрения менеджера.
 *
 * Инварианты:
 * - неподдерживаемый формат отклоняется до создания записи и до разбора;
 * - материал всегда остаётся в базе: сбой разбора даёт состояние `error`,
 *   а не исчезновение документа;
 * - материал в состоянии `pending` проиндексирован, но недоступен поиску —
 *   фильтр опубликованных источников живёт в модуле `knowledge`;
 * - ошибка разбора не должна выглядеть как пустой успешный ответ: материал
 *   возвращается менеджеру в состоянии ошибки с понятным текстом.
 */

/** Предельный размер файла: 20 МБ. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Минимальный размер чанка: короче цитировать нечего. */

/** Каталог хранения загруженных файлов. */
export function documentsDirectory(): string {
  return process.env["KB_DOCUMENTS_DIR"] ?? join(tmpdir(), "aisupport-kb-documents");
}

/**
 * Провайдер эмбеддингов для индексации.
 *
 * По умолчанию — тот же провайдер, которым индексирована база знаний: вектор
 * запроса и вектор чанка обязаны строить одну моделью, иначе поиск отвергнет
 * чанк. Провайдер модуля `knowledge` выбирается при старте приложения: при
 * наличии ключа — живой, без ключа — детерминированный.
 */
function resolveEmbeddingProvider(options: DocumentUploadOptions): DocumentEmbeddingProvider {
  if (options.embeddingProvider) return options.embeddingProvider;
  const current = currentEmbeddingProvider();
  return { embed: current.embed, model: current.model };
}

/** Хеш содержимого: по нему повторная загрузка того же файла распознаётся. */
function snapshotHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Загрузка документа менеджером.
 *
 * @param input файл, арендатор и автор загрузки.
 * @param options подмены разборщика и провайдера эмбеддингов.
 */
export async function uploadDocument(
  input: DocumentUploadInput,
  options: DocumentUploadOptions = {},
): Promise<DocumentRecord> {
  if (input.bytes.length === 0) {
    throw new KnowledgeDocumentError(
      "validation_error",
      "file",
      "Файл пуст: загружать нечего.",
    );
  }
  if (input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new KnowledgeDocumentError(
      "payload_too_large",
      "file",
      `Файл больше предела ${MAX_DOCUMENT_BYTES} байт.`,
    );
  }

  // Формат определяется до всего остального: неподдерживаемый файл не
  // оставляет ни записи в базе, ни файла на диске.
  const format = detectFormat(input.filename, input.bytes);

  const id = randomUUID();
  const directory = join(documentsDirectory(), id);
  const storagePath = join(directory, safeFileName(input.filename));
  await mkdir(directory, { recursive: true });
  await writeFile(storagePath, input.bytes);

  try {
    const record = await insertDocument({
      id,
      tenantId: input.tenantId,
      filename: input.filename,
      mimeType: mimeTypeFor(format),
      sizeBytes: input.bytes.length,
      storagePath,
      snapshotHash: snapshotHash(input.bytes),
      provenance: {
        uploaded_by: input.uploadedBy,
        uploaded_at: new Date().toISOString(),
        source: "manager_upload",
        original_filename: input.filename,
        mime_detected: mimeTypeFor(format),
      },
    });

    return await processDocument(record, input.bytes, format, options, false);
  } catch (error) {
    // Запись не создана: файла на диске быть не должно.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Повторная попытка разбора документа в состоянии ошибки.
 *
 * Новая запись не создаётся: материал остаётся тем же, меняется только его
 * состояние. Так менеджер видит историю попыток, а не россып дублей.
 *
 * @param tenantId арендатор.
 * @param id идентификатор документа.
 * @param options подмены разборщика и провайдера эмбеддингов.
 */
export async function retryDocumentParse(
  tenantId: string,
  id: string,
  options: DocumentUploadOptions = {},
): Promise<DocumentRecord> {
  const record = await findDocument(tenantId, id);
  if (record === null) {
    throw new KnowledgeDocumentError("not_found", "id", "Документ не найден.");
  }
  if (record.status !== "error") {
    throw new KnowledgeDocumentError(
      "conflict",
      "id",
      "Повторный разбор возможен только для документа в состоянии ошибки.",
    );
  }

  const bytes = await readFile(record.storagePath);
  const format = detectFormat(record.filename, bytes);

  return processDocument(record, bytes, format, options, true);
}

/**
 * Одобрение менеджером: документ становится доступен поиску.
 *
 * @param tenantId арендатор.
 * @param id идентификатор документа.
 * @param actor кто одобрил.
 */
export async function approveDocument(
  tenantId: string,
  id: string,
  actor: string,
): Promise<DocumentRecord> {
  const record = await findDocument(tenantId, id);
  if (record === null) {
    throw new KnowledgeDocumentError("not_found", "id", "Документ не найден.");
  }
  if (record.status !== "pending") {
    throw new KnowledgeDocumentError(
      "conflict",
      "id",
      `Документ нельзя одобрить: текущее состояние «${record.status}».`,
    );
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await markPublished(client, { tenantId, documentId: id, actor });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const updated = await findDocument(tenantId, id);
  if (updated === null) {
    throw new KnowledgeDocumentError("not_found", "id", "Документ не найден.");
  }
  return updated;
}

/**
 * Отклонение менеджером: материал снимается с проверки.
 *
 * @param tenantId арендатор.
 * @param id идентификатор документа.
 * @param actor кто отклонил.
 * @param reason причина отклонения.
 */
export async function rejectDocument(
  tenantId: string,
  id: string,
  actor: string,
  reason: string,
): Promise<DocumentRecord> {
  const record = await findDocument(tenantId, id);
  if (record === null) {
    throw new KnowledgeDocumentError("not_found", "id", "Документ не найден.");
  }
  if (record.status !== "pending" && record.status !== "error") {
    throw new KnowledgeDocumentError(
      "conflict",
      "id",
      `Документ нельзя отклонить: текущее состояние «${record.status}».`,
    );
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await markRejected(client, { tenantId, documentId: id, actor, reason });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const updated = await findDocument(tenantId, id);
  if (updated === null) {
    throw new KnowledgeDocumentError("not_found", "id", "Документ не найден.");
  }
  return updated;
}

/** Документ арендатора по идентификатору. */
export async function getDocument(
  tenantId: string,
  id: string,
): Promise<DocumentRecord | null> {
  return findDocument(tenantId, id);
}

/** Документы арендатора для кабинета менеджера. */
export async function listDocuments(
  tenantId: string,
  filter: DocumentFilter = {},
): Promise<DocumentRecord[]> {
  return findDocuments(tenantId, filter);
}

/**
 * Разбор и индексация документа.
 *
 * Разбор и запись чанков идут в одной транзакции: частично проиндексированный
 * документ в базе не остаётся. Сбой приводит к состоянию `error`, а не к
 * половине материала.
 */
async function processDocument(
  record: DocumentRecord,
  bytes: Buffer,
  format: SupportedDocumentFormat,
  options: DocumentUploadOptions,
  isRetry: boolean,
): Promise<DocumentRecord> {
  const parser = options.parser ?? parseDocument;
  const provider = resolveEmbeddingProvider(options);
  const client = await getPool().connect();

  try {
    let text = "";
    let chunks: Chunk[] = [];

    try {
      const parsed = await parser(bytes, format);
      text = parsed.text;

      const chunkList = chunkDocument({
        filename: record.filename,
        text: parsed.text,
        uploadedAt: record.createdAt,
      });
      // Материал с содержательным текстом индексируется хотя бы одним
      // чанком, даже если он короче минимального размера: иначе короткий
      // документ оставался разобранным, но невидимым для поиска. Материал
      // без текста в индекс не попадает: цитировать нечего.
      chunks = selectIndexableChunks(chunkList);

      await client.query("BEGIN");
      await deleteChunks(client, record.tenantId, record.id);
      await insertChunks(
        client,
        {
          tenantId: record.tenantId,
          documentId: record.id,
          chunks: await withEmbeddings(chunks, provider),
          model: provider.model,
        },
      );
      await markParsed(client, {
        tenantId: record.tenantId,
        documentId: record.id,
        chunksCount: chunks.length,
        extractedChars: text.length,
        isRetry,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await markFailure(record, error, isRetry);
    }
  } finally {
    client.release();
  }

  const updated = await findDocument(record.tenantId, record.id);
  if (updated === null) {
    throw new KnowledgeDocumentError("not_found", "id", "Документ не найден.");
  }
  return updated;
}

/**
 * Векторы для чанков: считаются провайдером индекса.
 *
 * Вектор считается один раз на чанк и пишется вместе с моделью: вектор
 * запроса, построенный другой моделью, с вектором чанка несравним.
 */
async function withEmbeddings(
  chunks: Chunk[],
  provider: DocumentEmbeddingProvider,
): Promise<Array<{ chunkNo: number; text: string; embedding: number[] }>> {
  const result: Array<{ chunkNo: number; text: string; embedding: number[] }> = [];
  for (const chunk of chunks) {
    result.push({
      chunkNo: chunk.chunkNo,
      text: chunk.text,
      embedding: await provider.embed(chunk.text),
    });
  }
  return result;
}

/**
 * Фиксация сбоя разбора или индексации.
 *
 * Материал не удаляется: он остаётся видимым менеджеру в состоянии ошибки
 * с понятным текстом и может быть обработан повторно.
 */
async function markFailure(
  record: DocumentRecord,
  error: unknown,
  isRetry: boolean,
): Promise<void> {
  const message =
    error instanceof KnowledgeDocumentError
      ? error.message
      : error instanceof Error
        ? `Не удалось обработать документ: ${error.message.split("\n")[0] ?? "неизвестная ошибка"}`
        : "Не удалось обработать документ: неизвестная ошибка";

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await deleteChunks(client, record.tenantId, record.id);
    await markFailed(client, {
      tenantId: record.tenantId,
      documentId: record.id,
      parseError: message.slice(0, 500),
      isRetry,
    });
    await client.query("COMMIT");
  } catch (failure) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw failure;
  } finally {
    client.release();
  }
}

/** Имя файла на диске: путь не должен выходить за пределы каталога документа. */
function safeFileName(filename: string): string {
  const base = filename.split(/[\\/]/u).pop() ?? "document";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return cleaned.length > 0 ? cleaned : "document";
}

