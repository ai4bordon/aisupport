import { validateOutgoingText } from "@/core/validate";
import type { MaskMappingStore } from "@/core/mask-store";

/**
 * Исходящая проверка ответа канала (R14, AC 1).
 *
 * Ответ клиенту проходит проверку на необработанные персональные данные.
 * Клиент законно получает свои же данные обратно: значения, восстановленные
 * по таблице соответствий диалога, утечкой не считаются. Любое другое
 * персональное значение в ответе — утечка, и такой ответ наружу не уходит.
 *
 * Правила проверки живут в ядре (`src/core/validate.ts`): канал их не
 * дублирует, а получает готовую проверку через порт.
 */

/**
 * Порт проверки исходящего текста.
 *
 * Возвращает `true`, когда текст можно отправлять клиенту.
 */
export type OutgoingCheck = (
  text: string,
  conversationId: string,
) => Promise<boolean>;

/**
 * Собирает проверку исходящего текста по таблице соответствий диалога.
 *
 * Разрешённые значения берутся из таблицы соответствий: это значения,
 * которые клиент назвал сам, поэтому их возвращение в ответе законно.
 */
export function createOutgoingCheck(store: MaskMappingStore): OutgoingCheck {
  return async (text: string, conversationId: string): Promise<boolean> => {
    const mapping = await store.load(conversationId);
    const allowed = Object.values(mapping);
    return validateOutgoingText(text, allowed, []).valid;
  };
}
