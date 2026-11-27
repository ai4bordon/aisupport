import { getPool } from "@/db/pool";

/**
 * Публичный API модуля обещаний (docs/api-contract.md §1, §3).
 *
 * Модуль владеет таблицей `promises`: наружу отдаются `recordPromise`,
 * `listPromises` и `markPromiseDone`, доступ к `pg` остаётся внутри.
 *
 * Внешних интеграций доставки нет: ни SMTP, ни CRM, ни MAX из модуля не
 * вызываются, `reminded_at` не заполняется. Менеджер видит обещание в
 * журнале и отмечает его выполненным руками.
 */

/** Статус обещания: `open` — в работе, `done` — выполнено, `overdue` — просрочено. */
export type PromiseStatus = "open" | "done" | "overdue";

/** Запись журнала обещаний. */
export type PromiseRecord = {
  id: string;
  tenantId: string;
  conversationId: string;
  text: string;
  dueAt: string;
  owner: string;
  status: PromiseStatus;
  sourceKind: string | null;
  sourceId: string | null;
  isSynthetic: boolean;
  remindedAt: string | null;
  createdAt: string;
};

/** Данные новой записи обещания. */
export type RecordPromiseInput = {
  tenantId: string;
  conversationId: string;
  text: string;
  dueAt: string;
  owner: string;
  sourceKind?: string | null;
  sourceId?: string | null;
  isSynthetic?: boolean;
};

/** Фильтр журнала обещаний. */
export type ListPromisesFilter = {
  tenantId: string;
  status?: PromiseStatus;
  conversationId?: string;
};

type PromiseRow = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  text: string;
  due_at: Date;
  owner: string;
  status: PromiseStatus;
  source_kind: string | null;
  source_id: string | null;
  is_synthetic: boolean;
  reminded_at: Date | null;
  created_at: Date;
};

function toRecord(row: PromiseRow): PromiseRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    text: row.text,
    dueAt: row.due_at.toISOString(),
    owner: row.owner,
    status: row.status,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    isSynthetic: row.is_synthetic,
    remindedAt: row.reminded_at === null ? null : row.reminded_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Записывает обещание.
 *
 * Запись изолирована по `tenant_id`: обещание одного арендатора не должно
 * попасть в журнал другого.
 */
export async function recordPromise(input: RecordPromiseInput): Promise<PromiseRecord> {
  const result = await getPool().query<PromiseRow>(
    `INSERT INTO promises
       (tenant_id, conversation_id, text, due_at, owner, status,
        source_kind, source_id, is_synthetic)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)
     RETURNING *`,
    [
      input.tenantId,
      input.conversationId,
      input.text,
      input.dueAt,
      input.owner,
      input.sourceKind ?? null,
      input.sourceId ?? null,
      input.isSynthetic ?? false,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("запись обещания не создана");
  return toRecord(row);
}

/**
 * Переводит просроченные обещания в статус `overdue` и фиксирует это
 * в базе.
 *
 * Просрочка — вычисляемое состояние, а не фоновая задача: внешний
 * планировщик не нужен, `reminded_at` не заполняется.
 */
export async function markOverdue(tenantId: string): Promise<number> {
  const result = await getPool().query(
    `UPDATE promises
        SET status = 'overdue'
      WHERE tenant_id = $1
        AND status = 'open'
        AND due_at < now()`,
    [tenantId],
  );
  return result.rowCount ?? 0;
}

/**
 * Журнал обещаний арендатора.
 *
 * Перед выдачей просроченные записи переводятся в `overdue`, чтобы менеджер
 * видел актуальный статус, а не вычислял его сам.
 */
export async function listPromises(
  filter: ListPromisesFilter,
): Promise<PromiseRecord[]> {
  await markOverdue(filter.tenantId);

  const conditions = ["tenant_id = $1"];
  const values: unknown[] = [filter.tenantId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.conversationId !== undefined) {
    values.push(filter.conversationId);
    conditions.push(`conversation_id = $${values.length}`);
  }

  const result = await getPool().query<PromiseRow>(
    `SELECT * FROM promises
      WHERE ${conditions.join(" AND ")}
      ORDER BY due_at ASC, created_at ASC`,
    values,
  );
  return result.rows.map(toRecord);
}

/**
 * Отмечает обещание выполненным: менеджер вручную подтверждает отправку.
 *
 * Реальной отправки нет — ни SMTP, ни CRM, ни MAX из модуля не вызываются.
 */
export async function markPromiseDone(id: string, tenantId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE promises SET status = 'done' WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}
