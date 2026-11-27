import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chat } from "@/app/widget/chat";

/**
 * A1 — виджет ломается на втором ходу (BUGSAUDIT-2026-11-27).
 *
 * Виджет генерировал новый `conversation_id` на каждое сообщение: сервер
 * сверял тело с подписанной cookie и отклонял расхождение `403`, поэтому
 * веб-чат работал один ход за сессию.
 *
 * Cookie диалога помечена `HttpOnly` и из JavaScript не читается, поэтому
 * виджет берёт идентификатор из ответа сервера и помнит его для следующих
 * ходов.
 */

/** Ответ сервера: диалог, который виджет обязан запомнить. */
type ServerAnswer = {
  conversation_id: string;
  outcome: "respond" | "escalate";
  answer: { text: string; sources: unknown[] } | null;
  escalation: { reason: string; summary: string } | null;
};

describe("виджет веб-чата", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * Сервер, который ведёт себя как веб-чат: подписывает cookie, создаёт
   * диалог при первом ходе и отклоняет ход, чей идентификатор не совпадает
   * с идентификатором подписанного диалога.
   */
  function stubServer(): {
    calls: Array<{ conversation_id: string; text: string }>;
    conversationId: string;
  } {
    const conversationId = "ab2c3d4e-1111-4111-8111-111111111111";
    const calls: Array<{ conversation_id: string; text: string }> = [];
    let signed = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          conversation_id: string;
          message: { text: string };
        };
        calls.push({
          conversation_id: body.conversation_id,
          text: body.message.text,
        });

        // Подписанный диалог один: ход с чужим идентификатором отклоняется.
        if (signed && body.conversation_id !== conversationId) {
          return new Response(
            JSON.stringify({
              error: {
                code: "forbidden",
                message: "conversation_id не совпадает с подписанной cookie",
                details: { conversation_id: conversationId },
                request_id: "req-1",
              },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
        signed = true;

        const answer: ServerAnswer = {
          conversation_id: conversationId,
          outcome: "respond",
          answer: { text: "Ответ агента", sources: [] },
          escalation: null,
        };
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    return { calls, conversationId };
  }

  it("два хода подряд идут в одном диалоге и не отклоняются", async () => {
    const server = stubServer();

    render(<Chat />);
    const input = screen.getByLabelText("Сообщение");
    const send = screen.getByRole("button", { name: "Отправить" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Первый вопрос" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(server.calls).toHaveLength(1);
    });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Второй вопрос" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(server.calls).toHaveLength(2);
    });

    // Второй ход идёт с идентификатором подписанного диалога: сервер его
    // принял, а не отклонил.
    expect(server.calls[1]?.conversation_id).toBe(server.conversationId);
    // Ответа «Не удалось обработать запрос» на экране нет.
    expect(screen.queryByText("Не удалось обработать запрос. Попробуйте позже.")).toBeNull();
    expect(screen.getAllByText("Ответ агента")).toHaveLength(2);
  });

  it("после первого хода идентификатор диалога запоминается", async () => {
    const server = stubServer();

    render(<Chat />);
    const input = screen.getByLabelText("Сообщение");
    const send = screen.getByRole("button", { name: "Отправить" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Первый вопрос" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(server.calls).toHaveLength(1);
    });
    expect(
      window.sessionStorage.getItem("support_conversation_id"),
    ).toBe(server.conversationId);
  });
});
