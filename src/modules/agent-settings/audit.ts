import { getPool } from "@/db/pool";
import { SECRET_FIELD_NAMES } from "./store";

/**
 * Аудит изменений настроек (docs/plans/08-agent-settings-sandbox.md, шаг 6).
 *
 * Инварианты:
 * - запись содержит субъекта, действие, сущность и время;
 * - значения до и после безопасны: секретные поля заменены маской;
 * - сырые персональные данные и таблица соответствий меток ПД в аудит не
 *   попадают — аудит пишет только значения настроек.
 */

/** Маска вместо секретного значения. */
export const REDACTED = "[REDACTED]";

export type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  entity: string;
  /** Ключ изменённой настройки: `before` и `after` хранят одно поле. */
  key: string | null;
  before: unknown;
  after: unknown;
  /** Время записи: миллисекунды epoch, для сортировки по убыванию. */
  createdAt: number;
};

/**
 * Значения секретов из окружения.
 *
 * Сравнение с ними ловит случай, когда секрет попал в значение настройки
 * под другим именем поля: по имени поле не опознаётся, а значение всё
 * равно секрет.
 */
function environmentSecrets(): string[] {
  const names = [
    "OPENCODE_API_KEY",
    "MAX_BOT_TOKEN",
    "SESSION_SECRET",
    "MANAGER_CODE",
    "MANAGER_ACCESS_CODE",
    "ACCESS_CODE",
  ];
  const secrets: string[] = [];
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      secrets.push(value);
    }
  }
  return secrets;
}

function isSecretField(name: string): boolean {
  return SECRET_FIELD_NAMES.includes(name.toLowerCase());
}

/**
 * Маскирование секретов в произвольном значении.
 *
 * Маскируются поля с секретными именами и любые строковые значения,
 * совпадающие с секретом из окружения. Возвращается новая структура:
 * исходное значение не меняется.
 */
export function redactSecrets(value: unknown): unknown {
  const secrets = environmentSecrets();
  const seen = new WeakSet<object>();

  const walk = (current: unknown, name: string | null): unknown => {
    if (typeof current === "string") {
      if (name !== null && isSecretField(name)) {
        return REDACTED;
      }
      return secrets.some((secret) => current === secret) ? REDACTED : current;
    }
    if (current === null || typeof current !== "object") {
      return current;
    }
    if (seen.has(current)) {
      return "[Circular]";
    }
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map((item) => walk(item, name));
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      result[key] = walk(item, key);
    }
    return result;
  };

  return walk(value, null);
}

/**
 * Запись изменения настройки в аудит.
 *
 * Значения до и после проходят через маскирование: секрет в аудите не
 * хранится даже в замаскированном виде.
 */
export async function writeAuditChange(
  tenantId: string,
  actor: string,
  key: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity, before, after)
     VALUES ($1, $2, 'update', 'agent_settings', $3::jsonb, $4::jsonb)`,
    [
      tenantId,
      actor,
      JSON.stringify(redactSecrets({ [key]: before })),
      JSON.stringify(redactSecrets({ [key]: after })),
    ],
  );
}

type AuditRow = {
  id: string;
  actor: string;
  action: string;
  entity: string;
  before: unknown;
  after: unknown;
  created_at: Date;
};

/**
 * Ключ настройки из записи аудита.
 *
 * `before` и `after` хранят одно поле — имя настройки; по нему видно,
 * что именно менялось.
 */
function keyOf(record: unknown): string | null {
  if (typeof record !== "object" || record === null) {
    return null;
  }
  const names = Object.keys(record as Record<string, unknown>);
  return names.length === 1 ? (names[0] ?? null) : null;
}

/**
 * Записи аудита арендатора: от свежих к старым.
 *
 * Значения до и после дополнительно маскируются при чтении: запись,
 * сделанная до появления маскирования, тоже не должна отдавать секрет.
 */
export async function listAuditEntries(
  tenantId: string,
  limit: number = 50,
): Promise<AuditEntry[]> {
  const pool = getPool();
  const result = await pool.query<AuditRow>(
    `SELECT id, actor, action, entity, before, after, created_at
     FROM audit_log WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [tenantId, Math.max(1, Math.min(limit, 200))],
  );
  return result.rows.map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    entity: row.entity,
    key: keyOf(row.before),
    before: redactSecrets(row.before),
    after: redactSecrets(row.after),
    createdAt: row.created_at.getTime(),
  }));
}
