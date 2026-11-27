import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Контекст текущего хода диалога.
 *
 * Ход — это одно обращение клиента: у него есть идентификатор диалога и
 * идентификатор сообщения (`message_id`). Идентификатор сообщения нужен
 * записывающим модулям как часть идемпотентного ключа хода: шаг одного
 * хода не должен появиться дважды при повторной доставке.
 *
 * Контекст живёт в асинхронной цепочке вызовов, поэтому граница канала
 * задаёт его один раз, а записывающие модули читают идентификатор хода
 * отсюда, не меняя сигнатуры.
 */

/** Данные текущего хода диалога. */
export type DialogTurn = {
  conversationId: string;
  /** Идентификатор сообщения хода: `message_id` из контракта ядра. */
  messageId: string;
};

/** Контекст хода со счётчиком появлений узлов. */
type TurnScope = {
  turn: DialogTurn;
  /**
   * Счётчик появлений узла в ходе.
   *
   * Один и тот же узел встречается в ходе несколько раз: ядро пишет шаг
   * генерации и шаг доставки, оба с именем `respond`. Счётчик разводит их
   * по разным ключам, оставаясь детерминированным: повторная доставка
   * того же хода получает те же ключи.
   */
  nodeCounts: Map<string, number>;
};

const scope = new AsyncLocalStorage<TurnScope>();

/**
 * Выполняет операцию в контексте хода диалога.
 *
 * Повторный вход с тем же ходом переиспользует контекст: вложенный вызов
 * не начинает счётчики заново, иначе ключи шагов разошлись бы.
 */
export function runWithDialogContext<T>(
  turn: DialogTurn,
  operation: () => Promise<T>,
): Promise<T> {
  const current = scope.getStore();
  if (
    current &&
    current.turn.conversationId === turn.conversationId &&
    current.turn.messageId === turn.messageId
  ) {
    return operation();
  }
  return scope.run({ turn, nodeCounts: new Map<string, number>() }, operation);
}

/**
 * Контекст текущего хода диалога или `null`, если хода нет.
 */
export function currentDialogTurn(): DialogTurn | null {
  return scope.getStore()?.turn ?? null;
}

/**
 * Ключ шага хода: идентификатор сообщения, узел и номер появления узла.
 *
 * Ключ детерминирован для одного и того же хода: повторная доставка
 * сообщения даёт те же ключи, и уникальный индекс трассы отбрасывает
 * повтор без записи новой строки.
 *
 * Вне хода ключа нет: записывающий модуль берёт уникальный ключ, и шаг не
 * теряется. Контекст хода задаёт граница канала — см.
 * `runWithDialogContext`.
 */
export function nextStepKey(node: string): string | null {
  const current = scope.getStore();
  if (!current) return null;
  const occurrence = (current.nodeCounts.get(node) ?? 0) + 1;
  current.nodeCounts.set(node, occurrence);
  return `${current.turn.messageId}:${node}#${occurrence}`;
}
