import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { GET, POST } from "@/app/api/manager/knowledge/route";
import { KnowledgeClient } from "@/app/manager/knowledge/knowledge-client";
import { verifyManagerCode } from "@/modules/access";
import { buildManagerCookie } from "@/modules/access/session";
import { closePool } from "@/db/pool";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Раздел кабинета менеджера «База знаний».
 *
 * Проверяются три вещи:
 * 1) бренд-разметка — в файлах раздела нет сырых цветов, только токены;
 * 2) явные состояния — загрузка, ошибка, пусто, ошибка операции;
 * 3) маршрут данных — барьер менеджера, изоляция арендатора, честные списки.
 *
 * Документы и черновики статей — разные сущности с разными маршрутами
 * (ADR-0005): загрузка идёт в `POST /kb/documents`, одобрение документа —
 * в `POST /kb/documents/{id}/approve`, одобрение статьи — в
 * `POST /kb/drafts/{id}/approve`.
 */

/** `next/navigation` в тестовой среде: кабинет читает текущий путь. */
vi.mock("next/navigation", () => ({
  usePathname: () => "/manager/knowledge",
  useRouter: () => ({
    push: () => undefined,
    refresh: () => undefined,
  }),
}));

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
const TENANT_SLUG = "test-manager-ui-knowledge";
const MANAGER_CODE = "test-manager-code-ui-knowledge";
const SESSION_SECRET = "test-manager-secret-ui-knowledge";

type DocumentItem = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  parse_status: string;
  parse_error: string | null;
  chunks_count: number;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
};

type DraftItem = {
  id: string;
  title: string;
  status: string;
  conversation_id: string | null;
  source_message_ids: string[];
  source_excerpt: string | null;
  owner: string | null;
  created_at: string;
  approved_by: string | null;
  reviewed_at: string | null;
  published_at: string | null;
};

type KnowledgePayload = {
  documents: DocumentItem[];
  drafts: DraftItem[];
};

const samplePayload: KnowledgePayload = {
  documents: [
    {
      id: "doc-1",
      filename: "licensing.pdf",
      mime_type: "application/pdf",
      size_bytes: 20480,
      status: "pending",
      parse_status: "parsed",
      parse_error: null,
      chunks_count: 6,
      created_at: "2026-11-27T10:00:00.000Z",
      approved_by: null,
      approved_at: null,
    },
    {
      id: "doc-2",
      filename: "broken.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      status: "error",
      parse_status: "failed",
      parse_error: "Файл повреждён",
      chunks_count: 0,
      created_at: "2026-11-27T09:00:00.000Z",
      approved_by: null,
      approved_at: null,
    },
  ],
  drafts: [
    {
      id: "draft-1",
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

/**
 * Подмена `fetch`: маршрут данных отдаёт полезную нагрузку, операции —
 * заранее заданный ответ.
 */
function mockKnowledgeFetch(
  options: {
    payload?: KnowledgePayload;
    approveStatus?: number;
    approveBody?: unknown;
    uploadStatus?: number;
    uploadBody?: unknown;
  } = {},
): Mock {
  const payload = options.payload ?? samplePayload;
  const approveStatus = options.approveStatus ?? 200;
  const approveBody = options.approveBody ?? { id: "doc-1", status: "published" };
  const uploadStatus = options.uploadStatus ?? 202;
  const uploadBody = options.uploadBody ?? {
    id: "doc-3",
    status: "pending",
    filename: "licensing.pdf",
  };

  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "";

    if (url.includes("/approve")) {
      return new Response(JSON.stringify(approveBody), {
        status: approveStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/kb/documents")) {
      return new Response(JSON.stringify(uploadBody), {
        status: uploadStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/manager/knowledge")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Ответ с ошибкой в контрактном виде. */
function errorBody(code: string, message: string): unknown {
  return { error: { code, message, details: {}, request_id: "req-1" } };
}

async function managerCookie(): Promise<string> {
  process.env.MANAGER_ACCESS_CODE = MANAGER_CODE;
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = await verifyManagerCode(MANAGER_CODE);
  if (!session) throw new Error("Не удалось создать сессию менеджера");
  return buildManagerCookie(session).split(";")[0] ?? "";
}

describe("бренд-разметка раздела «База знаний»", () => {
  it("использует только фирменные токены без сырых цветов", async () => {
    const files = [
      "src/app/manager/knowledge/page.tsx",
      "src/app/manager/knowledge/knowledge-client.tsx",
      "src/app/manager/knowledge/styles.css",
    ];
    const contents = await Promise.all(
      files.map((file) => readFile(resolve(REPO_ROOT, file), "utf8")),
    );
    const source = contents.join("\n");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
    expect(source).toContain("var(--sl-");
  });

  it("показывает видимый фокус клавиатурной навигации", async () => {
    const styles = await readFile(
      resolve(REPO_ROOT, "src/app/manager/knowledge/styles.css"),
      "utf8",
    );
    expect(styles).toContain(":focus-visible");
    expect(styles).toMatch(/outline:\s*(?!none)/);
  });
});

describe("состояния раздела «База знаний»", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("показывает состояние загрузки", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(createElement(KnowledgeClient));
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем базу знаний");
  });

  it("показывает состояние ошибки и предлагает повторить", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Сеть недоступна")));
    render(createElement(KnowledgeClient));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось загрузить базу знаний",
    );
    expect(
      screen.getByRole("button", { name: /повторить/i }),
    ).toBeInTheDocument();
  });

  it("показывает пустые состояния для документов и черновиков", async () => {
    mockKnowledgeFetch({ payload: { documents: [], drafts: [] } });
    render(createElement(KnowledgeClient));

    expect(await screen.findByText("Документов пока нет")).toBeInTheDocument();
    const draftsTab = screen.getByRole("tab", { name: /Черновики статей/ });
    fireEvent.click(draftsTab);
    expect(screen.getByText("Черновиков пока нет")).toBeInTheDocument();
  });

  it("показывает загруженные документы и черновики статей", async () => {
    mockKnowledgeFetch();
    render(createElement(KnowledgeClient));

    expect(await screen.findByText("licensing.pdf")).toBeInTheDocument();
    expect(screen.getByText("На проверке")).toBeInTheDocument();
    expect(screen.getByText(/Ошибка разбора/)).toBeInTheDocument();
    expect(screen.getByText(/Файл повреждён/)).toBeInTheDocument();

    const draftsTab = await screen.findByRole("tab", { name: /Черновики статей/ });
    fireEvent.click(draftsTab);
    expect(
      screen.getByText("Куда приходят ключи после оплаты"),
    ).toBeInTheDocument();
    expect(screen.getByText("Ждёт решения")).toBeInTheDocument();
  });

  it("одобряет документ и сообщает об успехе", async () => {
    const fetchMock = mockKnowledgeFetch();
    render(createElement(KnowledgeClient));

    fireEvent.click(
      await screen.findByRole("button", { name: /Одобрить документ licensing\.pdf/ }),
    );

    await waitFor(() => {
      expect(screen.getByText(/одобрен и доступен поиску/i)).toBeInTheDocument();
    });

    const approveCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/approve"),
    );
    expect(approveCall).toBeDefined();
    expect(String(approveCall?.[0])).toContain("/api/kb/documents/doc-1/approve");
    const init = approveCall?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ actor: "manager" }));
  });

  it("одобряет черновик статьи отдельным маршрутом", async () => {
    const fetchMock = mockKnowledgeFetch();
    render(createElement(KnowledgeClient));

    const draftsTab = await screen.findByRole("tab", { name: /Черновики статей/ });
    fireEvent.click(draftsTab);
    fireEvent.click(
      await screen.findByRole("button", { name: /Одобрить статью/ }),
    );

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/approve"));
      expect(call).toBeDefined();
      expect(String(call?.[0])).toContain("/api/kb/drafts/draft-1/approve");
    });
  });

  it("отклоняет черновик статьи и сообщает об успехе", async () => {
    const fetchMock = mockKnowledgeFetch();
    render(createElement(KnowledgeClient));

    const draftsTab = await screen.findByRole("tab", { name: /Черновики статей/ });
    fireEvent.click(draftsTab);
    fireEvent.click(
      await screen.findByRole("button", { name: /Отклонить статью/ }),
    );

    await waitFor(() => {
      expect(screen.getByText(/отклонена/i)).toBeInTheDocument();
    });

    const rejectCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).endsWith("/api/manager/knowledge") &&
        (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(rejectCall).toBeDefined();
    const init = rejectCall?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "reject",
      draft_id: "draft-1",
      actor: "manager",
    });
  });

  it("показывает ошибку операции, когда сервер отклонил одобрение", async () => {
    mockKnowledgeFetch({
      approveStatus: 409,
      approveBody: errorBody("conflict", "Документ нельзя одобрить: текущее состояние «published»."),
    });
    render(createElement(KnowledgeClient));

    fireEvent.click(
      await screen.findByRole("button", { name: /Одобрить документ licensing\.pdf/ }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Документ нельзя одобрить");
  });

  it("загружает документ через форму", async () => {
    const fetchMock = mockKnowledgeFetch();
    render(createElement(KnowledgeClient));

    const input = (await screen.findByLabelText(/файл документа/i)) as HTMLInputElement;
    const file = new File(["тело документа"], "reglament.md", {
      type: "text/markdown",
    });
    fireEvent.change(input, { target: { files: [file] } });

    fireEvent.click(screen.getByRole("button", { name: /загрузить документ/i }));

    await waitFor(() => {
      expect(screen.getByText(/reglament\.md.*загружен/i)).toBeInTheDocument();
    });

    const uploadCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/api/kb/documents"),
    );
    expect(uploadCall).toBeDefined();
    const init = uploadCall?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
  });

  it("показывает ошибку загрузки для неподдерживаемого формата", async () => {
    mockKnowledgeFetch({
      uploadStatus: 415,
      uploadBody: errorBody(
        "unsupported_media_type",
        "Поддерживаются форматы: PDF, DOCX, Markdown, TXT.",
      ),
    });
    render(createElement(KnowledgeClient));

    const input = (await screen.findByLabelText(/файл документа/i)) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "archive.zip", { type: "application/zip" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /загрузить документ/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Поддерживаются форматы");
  });

  it("переключает вкладки клавиатурой", async () => {
    mockKnowledgeFetch();
    render(createElement(KnowledgeClient));

    const documentsTab = await screen.findByRole("tab", { name: /Документы/ });
    documentsTab.focus();
    fireEvent.keyDown(documentsTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Черновики статей/ })).toHaveFocus();
  });
});

describe("маршрут данных базы знаний", () => {
  let tenantId = "";
  let otherTenant = "";
  let cookie = "";

  beforeAll(async () => {
    await ensureSchema();
    cookie = await managerCookie();
  });

  beforeEach(async () => {
    tenantId = await resetTenant(TENANT_SLUG);
    const other = await testPool().query<{ id: string }>(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [`${TENANT_SLUG}-other`, "Другой арендатор"],
    );
    otherTenant = other.rows[0]?.id ?? "";

    await testPool().query(
      `INSERT INTO kb_documents (
         tenant_id, filename, mime_type, size_bytes, storage_path, status,
         chunks_count, created_at
       ) VALUES
         ($1, 'licensing.pdf', 'application/pdf', 20480, '/tmp/licensing.pdf',
          'pending', 6, '2026-11-27T10:00:00.000Z'),
         ($1, 'manual.md', 'text/markdown', 1024, '/tmp/manual.md',
          'published', 4, '2026-11-26T10:00:00.000Z'),
         ($2, 'чужой.pdf', 'application/pdf', 2048, '/tmp/other.pdf',
          'pending', 2, '2026-11-27T11:00:00.000Z')`,
      [tenantId, otherTenant],
    );

    await testPool().query(
      `INSERT INTO kb_articles (
         tenant_id, title, body_md, status, version, valid_from, owner, created_at
       ) VALUES
         ($1, 'Куда приходят ключи', 'Текст материала', 'pending_review', 1,
          now(), 'manager', '2026-11-27T08:00:00.000Z'),
         ($1, 'Условия лицензирования', 'Текст статьи', 'published', 1,
          now(), 'customer-site', '2026-11-26T08:00:00.000Z'),
         ($2, 'Чужая статья', 'Текст', 'pending_review', 1,
          now(), 'manager', '2026-11-27T12:00:00.000Z')`,
      [tenantId, otherTenant],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("не пускает запрос без cookie менеджера", async () => {
    const response = await GET(new Request("http://localhost/api/manager/knowledge"));
    expect(response.status).toBe(401);
  });

  it("отдаёт документы и черновики арендатора и прячет чужие", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/knowledge", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as KnowledgePayload;

    expect(body.documents.map((item) => item.filename)).toEqual([
      "licensing.pdf",
      "manual.md",
    ]);
    expect(body.documents.some((item) => item.filename === "чужой.pdf")).toBe(false);
    expect(body.drafts.map((item) => item.title)).toEqual([
      "Куда приходят ключи",
      "Условия лицензирования",
    ]);
    expect(body.drafts.some((item) => item.title === "Чужая статья")).toBe(false);
  });

  it("отдаёт состояние документа и понятную ошибку разбора", async () => {
    const response = await GET(
      new Request("http://localhost/api/manager/knowledge", {
        headers: { cookie },
      }),
    );
    const body = (await response.json()) as KnowledgePayload;
    const pending = body.documents.find((item) => item.filename === "licensing.pdf");
    expect(pending?.status).toBe("pending");
    expect(pending?.chunks_count).toBe(6);
    expect(pending?.created_at).toBe("2026-11-27T10:00:00.000Z");
  });

  it("возвращает пустые массивы для пустых таблиц", async () => {
    await testPool().query("DELETE FROM kb_chunks WHERE tenant_id = $1", [tenantId]);
    await testPool().query("DELETE FROM kb_articles WHERE tenant_id = $1", [tenantId]);
    await testPool().query("DELETE FROM kb_documents WHERE tenant_id = $1", [tenantId]);

    const response = await GET(
      new Request("http://localhost/api/manager/knowledge", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as KnowledgePayload;
    expect(body.documents).toEqual([]);
    expect(body.drafts).toEqual([]);
  });

  it("определяет арендатора на сервере и игнорирует тело запроса", async () => {
    const own = await testPool().query<{ id: string }>(
      "SELECT id FROM kb_articles WHERE tenant_id = $1 AND status = 'pending_review'",
      [tenantId],
    );
    const ownId = own.rows[0]?.id ?? "";

    // Арендатор в теле запроса игнорируется: решение применяется к
    // материалу того арендатора, которого видит сервер.
    const response = await POST(
      new Request("http://localhost/api/manager/knowledge", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          draft_id: ownId,
          tenant_id: otherTenant,
        }),
      }),
    );
    expect(response.status).toBe(200);

    const ownRows = await testPool().query<{ status: string }>(
      "SELECT status FROM kb_articles WHERE id = $1",
      [ownId],
    );
    expect(ownRows.rows[0]?.status).toBe("rejected");
  });

  it("не пускает отклонение без cookie менеджера", async () => {
    const response = await POST(
      new Request("http://localhost/api/manager/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject", draft_id: "любой" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("отклоняет черновик статьи и переводит его в rejected", async () => {
    const draft = await testPool().query<{ id: string }>(
      "SELECT id FROM kb_articles WHERE tenant_id = $1 AND status = 'pending_review'",
      [tenantId],
    );
    const draftId = draft.rows[0]?.id ?? "";

    const response = await POST(
      new Request("http://localhost/api/manager/knowledge", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "reject", draft_id: draftId, actor: "manager" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.id).toBe(draftId);
    expect(body.status).toBe("rejected");

    const rows = await testPool().query<{ status: string }>(
      "SELECT status FROM kb_articles WHERE id = $1",
      [draftId],
    );
    expect(rows.rows[0]?.status).toBe("rejected");
  });

  it("не отклоняет чужой черновик: чужой арендатор выглядит как отсутствующий", async () => {
    const foreign = await testPool().query<{ id: string }>(
      "SELECT id FROM kb_articles WHERE tenant_id = $1 AND status = 'pending_review'",
      [otherTenant],
    );
    const foreignId = foreign.rows[0]?.id ?? "";

    const response = await POST(
      new Request("http://localhost/api/manager/knowledge", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          draft_id: foreignId,
          tenant_id: otherTenant,
        }),
      }),
    );
    expect(response.status).toBe(404);

    const rows = await testPool().query<{ status: string }>(
      "SELECT status FROM kb_articles WHERE id = $1",
      [foreignId],
    );
    expect(rows.rows[0]?.status).toBe("pending_review");
  });

  it("не принимает решение по опубликованной статье", async () => {
    const published = await testPool().query<{ id: string }>(
      "SELECT id FROM kb_articles WHERE tenant_id = $1 AND status = 'published'",
      [tenantId],
    );
    const publishedId = published.rows[0]?.id ?? "";

    const response = await POST(
      new Request("http://localhost/api/manager/knowledge", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "reject", draft_id: publishedId }),
      }),
    );
    expect(response.status).toBe(409);
  });

  it("не принимает неизвестное действие", async () => {
    const response = await POST(
      new Request("http://localhost/api/manager/knowledge", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "publish", draft_id: "любой" }),
      }),
    );
    expect(response.status).toBe(400);
  });
});
