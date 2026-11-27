import { describe, expect, it } from "vitest";

import { normalizeMaxUpdate } from "@/channels/max";
import type { MaxUpdate } from "@/channels/max";

function messageCreated(overrides: Partial<MaxUpdate> = {}): MaxUpdate {
  return {
    update_type: "message_created",
    timestamp: 1_700_000_000_000,
    message: {
      body: { mid: "mid-1", text: "Сколько стоит KES на 50 устройств?" },
      recipient: { chat_id: 4242 },
    },
    ...overrides,
  } as MaxUpdate;
}

describe("normalizeMaxUpdate", () => {
  it("нормализует событие message_created в сообщение канала max", async () => {
    const normalized = await normalizeMaxUpdate(messageCreated());

    expect(normalized).not.toBeNull();
    expect(normalized?.channel).toBe("max");
    expect(normalized?.externalChatId).toBe("4242");
    expect(normalized?.text).toBe("Сколько стоит KES на 50 устройств?");
    expect(normalized?.messageId).toBe("mid-1");
    expect(normalized?.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(normalized?.maskedFieldsCount).toBe(0);
  });

  it("выводит один и тот же идентификатор диалога для одного и того же чата", async () => {
    const first = await normalizeMaxUpdate(messageCreated());
    const second = await normalizeMaxUpdate(messageCreated());

    expect(first?.conversationId).toBe(second?.conversationId);

    const other = await normalizeMaxUpdate(
      messageCreated({
        message: {
          body: { mid: "mid-1", text: "другой чат" },
          recipient: { chat_id: 4243 },
        },
      } as Partial<MaxUpdate>),
    );

    expect(other?.conversationId).not.toBe(first?.conversationId);
  });

  it("отбрасывает событие без chat_id, не бросая исключение", async () => {
    const update = messageCreated({
      message: {
        body: { mid: "mid-2", text: "сообщение без чата" },
        recipient: { chat_id: null },
      },
    } as Partial<MaxUpdate>);

    expect(await normalizeMaxUpdate(update)).toBeNull();
  });

  it("отбрасывает событие без текста", async () => {
    const update = messageCreated({
      message: {
        body: { mid: "mid-3", text: null },
        recipient: { chat_id: 4242 },
      },
    } as Partial<MaxUpdate>);

    expect(await normalizeMaxUpdate(update)).toBeNull();
  });

  it("не обрабатывает события других типов", async () => {
    const update = messageCreated({ update_type: "bot_started" } as Partial<MaxUpdate>);

    expect(await normalizeMaxUpdate(update)).toBeNull();
  });

  it("применяет порт маскирования ядра, когда он передан", async () => {
    const normalized = await normalizeMaxUpdate(messageCreated(), {
      mask: (text: string) => ({
        maskedText: text.replace("50", "⟦COUNT_1⟧"),
        maskedFieldsCount: 1,
      }),
    });

    expect(normalized?.text).toBe("Сколько стоит KES на ⟦COUNT_1⟧ устройств?");
    expect(normalized?.maskedFieldsCount).toBe(1);
  });

  it("передаёт идентификатор диалога в порт маскирования", async () => {
    // Таблица соответствий меток накапливается по диалогу, поэтому порт
    // должен знать, к какому диалогу относится сообщение.
    let seenConversationId = "";

    const normalized = await normalizeMaxUpdate(messageCreated(), {
      mask: (text: string, conversationId: string) => {
        seenConversationId = conversationId;
        return { maskedText: text, maskedFieldsCount: 0 };
      },
    });

    expect(seenConversationId).not.toBe("");
    expect(seenConversationId).toBe(normalized?.conversationId);
  });
});
