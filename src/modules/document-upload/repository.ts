import { getPool } from "@/db/pool";
import { toVectorLiteral } from "@/db/vector";

import type { DocumentFilter, DocumentRecord, DocumentStatus, ParseStatus } from "./types";

/**
 * Доступ к документам базы знаний.
 *
 * Работа с `pg` остаётся внутри модуля: наружу отдаются операции с доменными
 * типами, а не строки базы.
 */

/** Строка таблицы `kb_documents`. */
type DocumentRow = {
  id: string;
  tenant_id: string;
  filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  status: DocumentStatus;
  parse_status: ParseStatus;
  parse_error: string | null;
  chunks_count: number;
  extracted_chars: number;
  source_kind: "manager_upload";
  source_url: string | null;
  snapshot_hash: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_reason: string | null;
  retry_count: number;
  created_at: Date;
};

/** Колонки документа: читаются одинаково во всех выборках. */
const COLUMNS = `
  id, tenant_id, filename, mime_type, size_bytes, storage_path, status, parse_status, parse_error,
  chunks_count, extracted_chars, source_kind, source_url, snapshot_hash,
  approved_by, approved_at, rejected_reason, retry_count, created_at
`;

/** Доменная запись из строки таблицы. */
function toRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    storagePath: row.storage_path,
    status: row.status,
    parseStatus: row.parse_status,
    parseError: row.parse_error,
    chunksCount: Number(row.chunks_count),
    extractedChars: Number(row.extracted_chars),
    sourceKind: row.source_kind,
    sourceUrl: row.source_url,
    snapshotHash: row.snapshot_hash,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at?.toISOString() ?? null,
    rejectedReason: row.rejected_reason,
    retryCount: Number(row.retry_count),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Создание записи документа в состоянии «на проверке».
 *
 * Разбор и индексация идут позже: запись появляется сразу, чтобы менеджер
 * видел материал даже тогда, когда разбор не удался.
 */
export async function insertDocument(input: {
  id: string;
  tenantId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  snapshotHash: string;
  provenance: Record<string, unknown>;
}): Promise<DocumentRecord> {
  const result = await getPool().query<DocumentRow>(
    `INSERT INTO kb_documents (
       id, tenant_id, filename, mime_type, size_bytes, storage_path, status,
       parse_status, chunks_count, extracted_chars, source_kind, snapshot_hash, provenance
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'not_parsed', 0, 0, 'manager_upload', $7, $8::jsonb)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.storagePath,
      input.snapshotHash,
      JSON.stringify(input.provenance),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Запись документа не создана");
  return toRecord(row);
}

/** Документ арендатора по идентификатору. */
export async function findDocument(
  tenantId: string,
  id: string,
): Promise<DocumentRecord | null> {
  const result = await getPool().query<DocumentRow>(
    `SELECT ${COLUMNS} FROM kb_documents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Документы арендатора с фильтром по состоянию. */
export async function findDocuments(
  tenantId: string,
  filter: DocumentFilter,
): Promise<DocumentRecord[]> {
  const conditions = ["tenant_id = $1"];
  const values: unknown[] = [tenantId];
  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.parseStatus !== undefined) {
    values.push(filter.parseStatus);
    conditions.push(`parse_status = $${values.length}`);
  }

  const result = await getPool().query<DocumentRow>(
    `SELECT ${COLUMNS} FROM kb_documents
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(toRecord);
}

/**
 * Чанки документа: удаляются перед перезаписью.
 *
 * Повторная попытка разбора не должна плодить дубли: чанки документа
 * принадлежат только ему, поэтому заменяются целиком.
 */
export async function deleteChunks(client: Transaction, tenantId: string, documentId: string): Promise<void> {
  await client.query("DELETE FROM kb_chunks WHERE tenant_id = $1 AND document_id = $2", [
    tenantId,
    documentId,
  ]);
}

/** Транзакция: клиент пула и общий интерфейс запросов. */
export type Transaction = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

/**
 * Запись чанков документа.
 *
 * Вектор записывается вместе с моделью, которой он построен: вектор запроса,
 * построенный другой моделью, с вектором чанка несравним, и поиск отверг бы
 * такой чанк.
 */
export async function insertChunks(
  client: Transaction,
  input: {
    tenantId: string;
    documentId: string;
    chunks: Array<{ chunkNo: number; text: string; embedding: number[] }>;
    model: string;
  },
): Promise<void> {
  for (const chunk of input.chunks) {
    await client.query(
      `INSERT INTO kb_chunks (
         tenant_id, document_id, chunk_no, text, search_vector, embedding, embedding_model
       ) VALUES ($1, $2, $3, $4, to_tsvector('russian', $4), $5::vector, $6)`,
      [
        input.tenantId,
        input.documentId,
        chunk.chunkNo,
        chunk.text,
        toVectorLiteral(chunk.embedding),
        input.model,
      ],
    );
  }
}

/**
 * Результат успешного разбора: материал разобран, ждёт одобрения.
 *
 * Счётчик попыток растёт только при повторной обработке: первая загрузка —
 * это первая попытка, а не «повтор», и считать её повтором было бы враньём в
 * журнале восстановления.
 */
export async function markParsed(
  client: Transaction,
  input: {
    tenantId: string;
    documentId: string;
    chunksCount: number;
    extractedChars: number;
    isRetry: boolean;
  },
): Promise<void> {
  await client.query(
    `UPDATE kb_documents
     SET parse_status = 'parsed',
         parse_error = NULL,
         status = 'pending',
         chunks_count = $3,
         extracted_chars = $4,
         parsed_at = now(),
         last_attempt_at = now(),
         failed_at = NULL,
         retry_count = retry_count + CASE WHEN $5 THEN 1 ELSE 0 END
     WHERE tenant_id = $1 AND id = $2`,
    [
      input.tenantId,
      input.documentId,
      input.chunksCount,
      input.extractedChars,
      input.isRetry,
    ],
  );
}

/**
 * Результат неудачного разбора: материал остаётся в базе в состоянии ошибки.
 *
 * Документ не удаляется: менеджер должен видеть, что материал не удался, и
 * повторить попытку. Счётчик попыток и время последней попытки пишутся рядом
 * — по ним видно, что попытка была и когда.
 */
export async function markFailed(
  client: Transaction,
  input: {
    tenantId: string;
    documentId: string;
    parseError: string;
    isRetry: boolean;
  },
): Promise<void> {
  await client.query(
    `UPDATE kb_documents
     SET parse_status = 'failed',
         parse_error = $3,
         status = 'error',
         chunks_count = 0,
         failed_at = now(),
         last_attempt_at = now(),
         retry_count = retry_count + CASE WHEN $4 THEN 1 ELSE 0 END
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.documentId, input.parseError, input.isRetry],
  );
}

/** Одобрение менеджером: материал становится доступен поиску. */
export async function markPublished(
  client: Transaction,
  input: { tenantId: string; documentId: string; actor: string },
): Promise<void> {
  await client.query(
    `UPDATE kb_documents
     SET status = 'published', approved_at = now(), approved_by = $3
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.documentId, input.actor],
  );
}

/** Отклонение менеджером: материал снимается с проверки. */
export async function markRejected(
  client: Transaction,
  input: { tenantId: string; documentId: string; actor: string; reason: string },
): Promise<void> {
  await client.query(
    `UPDATE kb_documents
     SET status = 'rejected', rejected_reason = $3, approved_by = $4
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.documentId, input.reason, input.actor],
  );
}
