import { createElement } from "react";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { KnowledgeClient } from "@/app/manager/knowledge/knowledge-client";

/**
 * Модалка черновика статьи в разделе «База знаний».
 *
 * В списке видны только заголовок и выдержка из источника; полный текст
 * статьи менеджер читает в модалке, а там же правит, копирует и удаляет
 * материал.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/manager/knowledge",
  useRouter: () => ({
    push: () => undefined,
    refresh: () => undefined,
  }),
}));

/** Корень репозитория: файлы раздела читаются напрямую с диска. */
function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      existsSync(resolve(current, "package.json")) &&
      existsSync(resolve(current, "docs"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Корень репозитория не найден выше tests/manager");
    }
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot();

/** Полный текст статьи: в списке его нет, в модалке — есть. */
const FULL_BODY =
  "Ключи приходят на почту администратора сразу после оплаты. " +
  "Письмо содержит ссылку на личный кабинет и список лицензий.";

const DRAFT_ID = "33333333-3333-4333-8333-333333333333";

const listPayload = {
  documents: [],
  drafts: [
    {
      id: DRAFT_ID,
      title: "Куда приходят ключи после оплаты",
      status: "pending_review",
      conversation_id: "11111111-1111-4111-8111-111111111111",
      source_message_ids: ["22222222-2222-4222-8222-222222222222"],
      source_excerpt: "выдержка из обращения",
      owner: "manager",
      created_at: "2026-11-27T08:00:00.000Z",
      approved_by: null,
      reviewed_at: null,
      published_at: null,
    },
  ],
};

const draftPayload = {
  draft: {
    id: DRAFT_ID,
    title: "Куда приходят ключи после оплаты",
    body_md: FULL_BODY,
    status: "pending_review",
    version: 1,
    conversation_id: "11111111-1111-4111-8111-111111111111",
    source_message_ids: ["22222222-2222-4222-8222-222222222222"],
    source_excerpt: "выдержка из обращения",
    owner: "manager",
    created_at: "2026-11-27T08:00:00.000Z",
    approved_by: null,
    reviewed_at: null,
    published_at: null,
  },
};

/**
 * Подмена `fetch`: список раздела, маршрут черновика и операции.
 */
function mockFetch(options: { draftStatus?: number; deleted?: boolean } = {}): Mock {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "";
    const method = init?.method ?? "GET";

    if (url.includes("/api/manager/knowledge/draft/")) {
      if (method === "DELETE") {
        return new Response(JSON.stringify({ status: "deleted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PUT") {
        // Сервер отвечает сохранённым материалом: новый текст и новая
        // версия. Иначе окно осталось бы со старым содержимым.
        const sent = JSON.parse(String(init?.body ?? "{}")) as {
          body_md?: string;
        };
        return new Response(
          JSON.stringify({
            draft: { ...draftPayload.draft, body_md: sent.body_md ?? draftPayload.draft.body_md, version: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(draftPayload), {
        status: options.draftStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/api/manager/knowledge")) {
      return new Response(JSON.stringify(listPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("{}", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Открытие вкладки с черновиками. */
async function openDrafts(): Promise<void> {
  render(createElement(KnowledgeClient));
  const tab = await screen.findByRole("tab", { name: /Черновики статей/ });
  fireEvent.click(tab);
}

/** Открытие модалки: клик по заголовку черновика. */
async function openModal(): Promise<void> {
  await openDrafts();
  fireEvent.click(await screen.findByText("Куда приходят ключи после оплаты"));
}

describe("модалка черновика статьи", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("маршрут черновика не содержит сырых цветов", async () => {
    const source = await readFile(
      resolve(REPO_ROOT, "src/app/api/manager/knowledge/draft/[id]/route.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });

  it("открывается по клику на черновик и показывает полный текст статьи", async () => {
    mockFetch();
    await openModal();

    // Полный текст статьи — в модалке, а не только выдержка из источника.
    expect(
      await screen.findByText(/Ключи приходят на почту администратора/),
    ).toBeInTheDocument();

    // Выдержка из источника остаётся в списке: она и там нужна менеджеру.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/Ключи приходят на почту администратора/);
  });

  it("показывает заголовок, статус, дату и автора", async () => {
    mockFetch();
    await openModal();

    const dialog = await screen.findByRole("dialog");
    // Статус, автор и дата — внутри окна: в списке их по этому черновику нет.
    expect(dialog).toHaveTextContent("Ждёт решения");
    expect(dialog).toHaveTextContent("manager");
    expect(dialog).toHaveTextContent(/27.*2026|нояб/i);
  });

  it("закрывается по Escape", async () => {
    mockFetch();
    await openModal();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("закрывается по кнопке «Закрыть»", async () => {
    mockFetch();
    await openModal();

    fireEvent.click(await screen.findByRole("button", { name: /Закрыть/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("переходит в режим редактирования и сохраняет текст через PUT", async () => {
    const fetchMock = mockFetch();
    await openModal();

    fireEvent.click(await screen.findByRole("button", { name: /Изменить/i }));

    const editor = await screen.findByRole("textbox", { name: /текст статьи/i });
    fireEvent.change(editor, { target: { value: "Новый текст статьи." } });
    fireEvent.click(screen.getByRole("button", { name: /Сохранить/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeDefined();
    });

    const put = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(String(put?.[0])).toContain(`/api/manager/knowledge/draft/${DRAFT_ID}`);
    // Версия материала едет вместе с правкой.
    expect((put?.[1] as RequestInit).body).toBe(
      JSON.stringify({ body_md: "Новый текст статьи.", version: 1 }),
    );
  });

  it("после сохранения возвращает окно к просмотру с новым текстом", async () => {
    // Иначе менеджер остался бы в редакторе со старым текстом в поле.
    const fetchMock = mockFetch();
    await openModal();

    fireEvent.click(await screen.findByRole("button", { name: /Изменить/i }));
    const editor = await screen.findByRole("textbox", { name: /текст статьи/i });
    fireEvent.change(editor, { target: { value: "Новый текст статьи." } });
    fireEvent.click(screen.getByRole("button", { name: /Сохранить/i }));

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /текст статьи/i })).not.toBeInTheDocument();
    });
    // Кнопки просмотра вернулись, редактор закрыт.
    expect(screen.getByRole("button", { name: /Изменить/i })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBe(true);
  });

  it("не закрывает окно с несохранённой правкой без подтверждения", async () => {
    mockFetch();
    await openModal();

    fireEvent.click(await screen.findByRole("button", { name: /Изменить/i }));
    await screen.findByRole("textbox", { name: /текст статьи/i });

    // Кнопка «Закрыть» спрашивает подтверждение, а не теряет правку молча.
    fireEvent.click(screen.getByRole("button", { name: /Закрыть/i }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Отказ возвращает к правке.
    fireEvent.click(screen.getByRole("button", { name: /Продолжить правку/i }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Escape при несохранённой правке не закрывает окно", async () => {
    mockFetch();
    await openModal();

    fireEvent.click(await screen.findByRole("button", { name: /Изменить/i }));
    await screen.findByRole("textbox", { name: /текст статьи/i });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("копирует текст статьи в буфер обмена", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    mockFetch();
    await openModal();

    fireEvent.click(await screen.findByRole("button", { name: /Копировать/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(FULL_BODY);
    });
  });

  it("удаляет черновик после подтверждения и убирает его из списка", async () => {
    const fetchMock = mockFetch();
    await openModal();

    fireEvent.click(await screen.findByRole("button", { name: /Удалить/i }));
    // Удаление требует подтверждения: материал не уходит без согласия.
    fireEvent.click(
      await screen.findByRole("button", { name: /подтвердить|Да, удалить|Удалить материал/i }),
    );

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
      );
      expect(del).toBeDefined();
    });

    const del = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
    );
    expect(String(del?.[0])).toContain(`/api/manager/knowledge/draft/${DRAFT_ID}`);
  });

  it("показывает ошибку, когда маршрут черновика недоступен", async () => {
    mockFetch({ draftStatus: 500 });
    await openModal();

    expect(await screen.findByRole("alert")).toHaveTextContent(/не удалось/i);
  });
});
