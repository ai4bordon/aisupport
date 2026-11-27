import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getPool } from "@/db/pool";
import type { PoolClient } from "pg";

/**
 * Сериализация записи состояния диалога (R16, AC 4).
 *
 * Один диалог — одна очередь записей: сообщения, шаги трассы и слоты
 * пишутся под блокировкой уровня диалога, поэтому два параллельных хода
 * не могут повредить состояние друг друга.
 *
 * Блокировка берётся на уровне PostgreSQL (`pg_advisory_xact_lock`), а не в
 * памяти процесса: веб-чат и воркер MAX — разные процессы, и блокировка
 * должна быть общей. Ключ 64-битный и одинаковый во всех процессах: он
 * выводится из идентификатора диалога хешем, а не счётчиком в модуле.
 *
 * Блокировка не удерживается во время сетевого вызова модели: операция
 * внутри неё — только запросы к базе.
 */

/** Уже занятая блокировка в текущей асинхронной цепочке. */
type HeldLock = {
  client: PoolClient;
  conversationId: string;
};

const heldLock = new AsyncLocalStorage<HeldLock>();

/**
 * Ключ блокировки диалога: 64-битное число со знаком.
 *
 * Хеш берётся от идентификатора диалога, поэтому ключ одинаков в любом
 * процессе и для любого диалога. Старшие биты отбрасываются, чтобы
 * значение помещалось в `bigint` PostgreSQL.
 */
export function dialogLockKey(conversationId: string): bigint {
  const digest = createHash("sha256").update(conversationId).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/**
 * Выполняет операцию под блокировкой диалога.
 *
 * Операция получает соединение из той же транзакции: её запросы видят
 * данные операции и откатываются вместе с ней. Блокировка освобождается
 * при завершении транзакции — и при успехе, и при ошибке.
 */
export async function withDialogLock<T>(
  conversationId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const held = heldLock.getStore();
  if (held) {
    // Блокировка уже держится в этой асинхронной цепочке. Тот же диалог —
    // блокировка переиспользуется; другой диалог — берётся ещё одна
    // блокировка в той же транзакции (`pg_advisory_xact_lock` держит
    // несколько ключей одновременно).
    if (held.conversationId !== conversationId) {
      await held.client.query("SELECT pg_advisory_xact_lock($1)", [
        dialogLockKey(conversationId).toString(),
      ]);
    }
    return operation(held.client);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      dialogLockKey(conversationId).toString(),
    ]);
    const result = await heldLock.run(
      { client, conversationId },
      () => operation(client),
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
