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

  it("показывает, что агент печатает, пока ответа нет", async () => {
    // Регрессия живьёма (UX-аудит 28.11): кнопка «Отправить» гасла, и
    // две-три секунды тишины читались как зависание.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(
          JSON.stringify({
            conversation_id: "ab2c3d4e-1111-4111-8111-111111111111",
            outcome: "respond",
            answer: { text: "Ответ агента", sources: [] },
            escalation: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(<Chat />);
    const input = screen.getByLabelText("Сообщение");
    const send = screen.getByRole("button", { name: "Отправить" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Вопрос" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    expect(await screen.findByText("Агент печатает…")).toBeInTheDocument();

    release();
    await waitFor(() => {
      expect(screen.queryByText("Агент печатает…")).toBeNull();
    });
  });

  it("прокручивает ленту к ответу агента", async () => {
    // Регрессия живьёма (UX-аудит 28.11): ответ приходил ниже видимой
    // области, экран оставался наверху, и человек видел только свой
    // вопрос — ответа как будто не было.
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

    const log = document.querySelector(".chat__log") as HTMLElement | null;
    expect(log).not.toBeNull();
    expect(log?.scrollTop).toBe(log?.scrollHeight);
  });

  it("при 401 говорит, что сессия истекла, а не что обращение у менеджера", async () => {
    // Регрессия живьёма (UX-аудит 28.11): /v1/chat без доступа отдаёт
    // 401, а виджет на любой не-OK отвечал «Обращение передано
    // менеджеру» — это неправда: обращение никто не принимал.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "Требуется код доступа" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<Chat />);
    const input = screen.getByLabelText("Сообщение");
    const send = screen.getByRole("button", { name: "Отправить" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Вопрос" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    expect(
      await screen.findByText(/сессия истекла/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/передано менеджеру/i)).toBeNull();
  });

  it("при 429 говорит о лимите, а при 5xx — о сбое сервера", async () => {
    const stub = (status: number, code: string) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ error: { code, message: "" } }), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

    stub(429, "rate_limited");
    render(<Chat />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Сообщение"), {
        target: { value: "Вопрос" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    });
    expect(await screen.findByText(/лимит демо исчерпан/i)).toBeInTheDocument();

    cleanup();
    stub(503, "upstream_unavailable");
    render(<Chat />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Сообщение"), {
        target: { value: "Вопрос" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    });
    expect(await screen.findByText(/сервис недоступен/i)).toBeInTheDocument();
  });

  it("при реальной эскалации показывает её текст", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            outcome: "escalate",
            answer: null,
            escalation: {
              reason: "no_confirmed_source",
              summary: "Передаю ваш вопрос менеджеру.",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<Chat />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Сообщение"), {
        target: { value: "Вопрос" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    });

    expect(await screen.findByText("Передаю ваш вопрос менеджеру.")).toBeInTheDocument();
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

  it("при 422 показывает человеческую эскалацию, а не техническую заглушку", async () => {
    // Ответ не прошёл проверку: обращение уже ушло менеджеру, и клиент
    // должен видеть об этом человеческую фразу.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "approval_required",
              message: "Ответ не прошёл проверку и не отправлен клиенту",
              details: {},
              request_id: "req-1",
            },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<Chat />);
    const input = screen.getByLabelText("Сообщение");
    const send = screen.getByRole("button", { name: "Отправить" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Как оплатить подписку?" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(screen.getByText(/не прошёл проверку/i)).toBeInTheDocument();
    });
    // Фраза про менеджера тут уместна: при 422 обращение действительно
    // уходит менеджеру. Но технической заглушки быть не должно.
    expect(screen.getByText(/передано менеджеру/)).toBeInTheDocument();
    // Технической заглушки на экране нет.
    expect(screen.queryByText("Не удалось обработать запрос. Попробуйте позже.")).toBeNull();
  });

  it("при эскалации показывает её текст, а не заглушку", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            conversation_id: "ab2c3d4e-1111-4111-8111-111111111111",
            outcome: "escalate",
            answer: null,
            escalation: {
              reason: "no_confirmed_source",
              summary: "Передаю ваш вопрос менеджеру, он ответит в рабочее время.",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<Chat />);
    const input = screen.getByLabelText("Сообщение");
    const send = screen.getByRole("button", { name: "Отправить" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Вопрос" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(
        screen.getByText("Передаю ваш вопрос менеджеру, он ответит в рабочее время."),
      ).toBeInTheDocument();
    });
  });

  it("источник с http(s)-адресом — ссылка, безопасная ссылка — текстом", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            conversation_id: "ab2c3d4e-1111-4111-8111-111111111111",
            outcome: "respond",
            answer: {
              text: "Ответ агента",
              sources: [
                {
                  kind: "kb_article",
                  id: "art-1",
                  title: "Статья с адресом",
                  location: "https://store.softline.ru/test/1/",
                },
                {
                  kind: "kb_article",
                  id: "art-2",
                  title: "Статья без адреса",
                  location: null,
                },
                {
                  kind: "kb_article",
                  id: "art-3",
                  title: "Статья с опасным адресом",
                  location: "javascript:alert(1)",
                },
              ],
            },
            escalation: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<Chat />);
    const input = screen.getByLabelText("Сообщение");
    const send = screen.getByRole("button", { name: "Отправить" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "Вопрос" } });
    });
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(screen.getByText("Ответ агента")).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: /Статья с адресом/ });
    expect(link.getAttribute("href")).toBe("https://store.softline.ru/test/1/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");

    // Источник без адреса и источник с небезопасным адресом — текстом.
    expect(screen.queryByRole("link", { name: /Статья без адреса/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /опасным адресом/ })).toBeNull();
    expect(screen.getByText("Статья с опасным адресом")).toBeInTheDocument();
  });
});
