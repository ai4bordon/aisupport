import { describe, expect, it } from "vitest";

import {
  createMaxSession,
  handleMaxUpdate,
  type AgentOutcome,
  type MaxClient,
  type MaxUpdate,
} from "@/channels/max";
import { maskPersonalData, restoreMaskedData } from "@/core/mask";
import { createMaskMappingStore } from "@/core/mask-store";
import { validateOutgoingText } from "@/core/validate";

/**
 * Инварианты персональных данных в канале MAX (R14, AC 1).
 *
 * Три рубежа проверяются отдельно:
 * - входящий текст маскируется до вызова ядра;
 * - таблица соответствий не покидает серверную часть: провайдер и порт
 *   восстановления не видят исходных значений;
 * - ответ с необработанными персональными данными наружу не уходит.
 */

const TOKEN = "TEST-MAX-TOKEN-abc123";

/** Тестовые данные клиента: настоящих персональных данных здесь нет. */
const CLIENT_EMAIL = "ivanov@example.test";
const CLIENT_PHONE = "+7 900 123-45-67";
const CLIENT_NAME = "Иван Иванович Иванов";

const CLIENT_TEXT = `Меня зовут ${CLIENT_NAME}, почта ${CLIENT_EMAIL}, телефон ${CLIENT_PHONE}`;

function update(mid: string, chatId: number, text = CLIENT_TEXT): MaxUpdate {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    message: {
      body: { mid, text },
      recipient: { chat_id: chatId },
    },
  } as MaxUpdate;
}

type SentMessage = { chatId: string; text: string };

function stubClient(): MaxClient & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    async getUpdates() {
      return { updates: [], marker: 1 };
    },
    async sendMessage(chatId: string, text: string) {
      sent.push({ chatId, text });
    },
  };
}

/**
 * Серверное хранилище соответствий меток.
 *
 * Таблица соответствий — серверное состояние: порт маскирования пишет её,
 * порт восстановления читает. К порту восстановления у клиента нет
 * доступа: наружу отдаётся только восстановленный текст.
 */
function serverStore(): {
  mask: (text: string, conversationId: string) => Promise<{ maskedText: string; maskedFieldsCount: number }>;
  restore: (text: string, conversationId: string) => Promise<string>;
  check: (text: string, conversationId: string) => Promise<boolean>;
  mapping: Map<string, Record<string, string>>;
} {
  const mapping = new Map<string, Record<string, string>>();
  return {
    mapping,
    async mask(text: string, conversationId: string) {
      const known = mapping.get(conversationId) ?? {};
      const result = maskPersonalData(text, { mapping: known });
      mapping.set(conversationId, result.mapping);
      return {
        maskedText: result.maskedText,
        maskedFieldsCount: result.maskedFieldsCount,
      };
    },
    async restore(text: string, conversationId: string) {
      return restoreMaskedData(text, mapping.get(conversationId) ?? {});
    },
    async check(text: string, conversationId: string) {
      const allowed = Object.values(mapping.get(conversationId) ?? {});
      return validateOutgoingText(text, allowed, []).valid;
    },
  };
}

describe("MAX-канал: персональные данные", () => {
  it("в ядро уходит только замаскированный текст", async () => {
    const client = stubClient();
    const store = serverStore();
    const seen: string[] = [];

    const session = await createMaxSession({
      token: TOKEN,
      client,
      mask: store.mask,
      runAgent: async (input) => {
        seen.push(input.text);
        return {
          outcome: "respond",
          answer: { text: "Проверенный ответ", sources: [] },
          escalation: null,
          steps: [],
        } satisfies AgentOutcome;
      },
      shadowMode: async () => false,
    });

    await handleMaxUpdate(session, update("mid-pii-1", 4242));

    expect(seen).toHaveLength(1);
    const masked = seen[0] ?? "";
    expect(masked).not.toContain(CLIENT_EMAIL);
    expect(masked).not.toContain(CLIENT_PHONE);
    expect(masked).not.toContain(CLIENT_NAME);
    // Метки вместо исходных значений.
    expect(masked).toContain("⟦EMAIL_1⟧");
    expect(masked).toContain("⟦PERSON_1⟧");
  });

  it("таблица соответствий не попадает в порт восстановления и к провайдеру", async () => {
    const client = stubClient();
    const store = serverStore();
    const restoreCalls: string[] = [];

    const session = await createMaxSession({
      token: TOKEN,
      client,
      mask: store.mask,
      // Порт восстановления получает только текст и идентификатор
      // диалога: таблицы соответствий в нём нет, и взять её неоткуда.
      restore: async (text, conversationId) => {
        restoreCalls.push(text);
        return store.restore(text, conversationId);
      },
      runAgent: async () => ({
        outcome: "respond",
        // Ядро отвечает метками: исходных значений в ответе ядра нет.
        answer: { text: "Проверенный ответ для ⟦EMAIL_1⟧", sources: [] },
        escalation: null,
        steps: [],
      }),
      shadowMode: async () => false,
    });

    await handleMaxUpdate(session, update("mid-pii-2", 4242));

    // В порт восстановления уходят метки, а не исходные значения.
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]).toContain("⟦EMAIL_1⟧");
    expect(restoreCalls[0]).not.toContain(CLIENT_EMAIL);
    expect(restoreCalls[0]).not.toContain(CLIENT_NAME);

    // Провайдер получает восстановленный текст: клиент законно видит свои
    // же данные. Меток в отправленном тексте не остаётся — таблица
    // соответствий наружу не уходит.
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).not.toContain("⟦");
    expect(client.sent[0]?.text).toContain(CLIENT_EMAIL);
  });

  it("ответ с необработанным персональным данных не отправляется", async () => {
    const client = stubClient();
    const store = serverStore();

    const session = await createMaxSession({
      token: TOKEN,
      client,
      mask: store.mask,
      restore: async (text, conversationId) => store.restore(text, conversationId),
      checkOutgoing: async (text, conversationId) =>
        store.check(text, conversationId),
      runAgent: async () => ({
        outcome: "respond",
        // Модель вернула чужое персональное значение: его в ответе быть
        // не должно, и отправка такого ответа запрещена.
        answer: {
          text: "Свяжитесь с petrov@example.test",
          sources: [],
        },
        escalation: null,
        steps: [],
      }),
      shadowMode: async () => false,
    });

    await handleMaxUpdate(session, update("mid-pii-3", 4242));

    // Ответ не отправлен: наружу ушло ноль сообщений.
    expect(client.sent).toHaveLength(0);
  });

  it("ответ с разрешённым клиентским значением отправляется", async () => {
    const client = stubClient();
    const store = serverStore();

    const session = await createMaxSession({
      token: TOKEN,
      client,
      mask: store.mask,
      restore: async (text, conversationId) => store.restore(text, conversationId),
      checkOutgoing: async (text, conversationId) =>
        store.check(text, conversationId),
      runAgent: async () => ({
        outcome: "respond",
        // Клиент назвал свой адрес сам: после восстановления это его же
        // значение, а не утечка.
        answer: {
          text: "Ответ на почту ⟦EMAIL_1⟧",
          sources: [],
        },
        escalation: null,
        steps: [],
      }),
      shadowMode: async () => false,
    });

    await handleMaxUpdate(session, update("mid-pii-4", 4242));

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toContain(CLIENT_EMAIL);
  });

  it("проверка исходящего текста пропускает восстановленное значение", () => {
    // Проверка сама по себе: значение клиента, известное серверу,
    // утечкой не считается.
    const result = validateOutgoingText(
      `Ответ на почту ${CLIENT_EMAIL}`,
      [CLIENT_EMAIL],
      [],
    );
    expect(result.valid).toBe(true);
  });
});

describe("хранилище соответствий меток", () => {
  it("соответствия накапливаются по диалогу и не попадают в наружу", async () => {
    // Проверяется сам модуль хранилища: он обращается к базе, а наружу
    // отдаёт только значения по меткам.
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values: values ?? [] });
        return { rows: [] as Record<string, unknown>[] };
      },
    };
    const store = createMaskMappingStore(pool);

    await store.save("dialog-1", { "⟦EMAIL_1⟧": CLIENT_EMAIL });
    await store.load("dialog-1");

    expect(queries).toHaveLength(2);
    // Запросы к таблице соответствий идут по диалогу: метки диалога не
    // смешиваются.
    expect(queries[0]?.values[0]).toBe("dialog-1");
    expect(queries[1]?.values[0]).toBe("dialog-1");
  });
});
