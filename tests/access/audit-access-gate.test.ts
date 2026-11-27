import { createElement } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { default as pg } from "pg";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { POST } from "@/app/api/access/route";
import AccessPage from "@/app/access/page";
import * as access from "@/modules/access";
import {
  checkDailyDialogs,
  closePool,
  recordModelSpend,
} from "@/modules/limits";
import { buildSetCookie } from "@/core/session";

/**
 * Регресс-тест находок A2 и A3 аудита (BUGSAUDIT-2026-11-27.md).
 *
 * A2: страница `/access` отправляет form-urlencoded, а маршрут ждёт JSON —
 * барьер доступа не работает.
 *
 * A3: проверка доступа и лимиты стенда не подключены ни к одному маршруту
 * ядра.
 *
 * Команда проверки:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/support_agent \
 *   npx vitest run tests/access/audit-access-gate.test.ts --pool=forks --maxWorkers=1
 */

const TEST_CODE = "audit-gate-code-27";
const TEST_SECRET = "audit-gate-secret-27";
const TEST_MANAGER_CODE = "audit-gate-manager-27";
const TENANT_SLUG = "demo-tenant-audit-access-gate";

/** База стенда: свои счётчики, чужие тесты не задеваются. */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5433/support_agent";

const ACCESS_COOKIE = "support_access";
const MANAGER_COOKIE = "support_manager";

/**
 * Конвенционный файл Next.js грузится в рантайме: на базовой ветке его нет,
 * и тест обязан упасть с понятным сообщением, а не с ошибкой загрузки
 * модуля. Это граница загрузки модуля — статический импорт здесь ломал бы
 * весь файл.
 */
const MIDDLEWARE_PATH = resolve(process.cwd(), "src/middleware.ts");
const ACCESS_FORM_PATH = resolve(process.cwd(), "src/app/access/access-form.tsx");

type MiddlewareModule = {
  middleware: (request: NextRequest) => Promise<Response>;
  config: { matcher: string[] };
};

type AccessFormModule = {
  AccessForm: () => React.ReactElement;
};

let middlewareModule: MiddlewareModule | null = null;
let middlewareLoadError: string | null = null;
let accessFormModule: AccessFormModule | null = null;
let accessFormLoadError: string | null = null;

/**
 * Клиентский компонент формы грузится в рантайме: на базовой ветке его нет,
 * и тест обязан упасть с понятным сообщением, а не с ошибкой загрузки
 * модуля. Это граница загрузки модуля — статический импорт здесь ломал бы
 * весь файл.
 */
async function loadAccessForm(): Promise<AccessFormModule["AccessForm"]> {
  if (!accessFormModule) {
    try {
      accessFormModule = (await import(
        /* @vite-ignore */ pathToFileURL(ACCESS_FORM_PATH).href
      )) as AccessFormModule;
    } catch (error) {
      accessFormLoadError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!accessFormModule) {
    throw new Error(
      `форма доступа не найдена: ${ACCESS_FORM_PATH} не загрузился (${
        accessFormLoadError ?? "нет файла"
      })`,
    );
  }
  return accessFormModule.AccessForm;
}

/** Значение cookie из заголовка `Set-Cookie`. */
function cookieValue(setCookie: string | null): string {
  const pair = (setCookie ?? "").split(";")[0] ?? "";
  const separator = pair.indexOf("=");
  return separator >= 0 ? pair.slice(separator + 1) : "";
}

/** HTTP-запрос к барьеру: путь, IP и cookie. */
function nextRequest(
  pathname: string,
  options: { method?: string; cookie?: string; ip?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  if (options.ip) {
    headers["x-forwarded-for"] = options.ip;
  }
  return new NextRequest(`http://localhost${pathname}`, {
    method: options.method ?? "GET",
    headers,
  });
}

/** Запрос к маршруту входа: JSON или form-urlencoded. */
function postAccess(body: unknown, asForm = false): Promise<Response> {
  return POST(
    new Request("http://localhost/api/access", {
      method: "POST",
      headers: asForm
        ? { "content-type": "application/x-www-form-urlencoded" }
        : { "content-type": "application/json" },
      body: asForm
        ? `code=${encodeURIComponent(String(body))}`
        : JSON.stringify(body),
    }),
  );
}

/** Cookie стенда, выданная настоящим кодом. */
async function issueAccessCookie(): Promise<string> {
  const response = await POST(
    new Request("http://localhost/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: TEST_CODE }),
    }),
  );
  return `${ACCESS_COOKIE}=${cookieValue(response.headers.get("set-cookie"))}`;
}

/** Подписанная cookie диалога: запрос внутри диалога не расходует квоту. */
function conversationCookie(): string {
  return buildSetCookie("11111111-2222-4333-8444-555555555555").split(";")[0] as string;
}

/**
 * Вызов барьера.
 *
 * На базовой ветке `src/middleware.ts` нет: тест падает с понятным
 * сообщением о неподключённом барьере, а не с `undefined`.
 */
async function callMiddleware(request: NextRequest): Promise<Response> {
  if (!middlewareModule) {
    throw new Error(
      `барьер доступа не подключён: ${MIDDLEWARE_PATH} не загрузился (${
        middlewareLoadError ?? "нет файла"
      })`,
    );
  }
  return middlewareModule.middleware(request);
}

describe("A2/A3 — барьер доступа и лимиты стенда подключены", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.TENANT_SLUG = TENANT_SLUG;

    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO tenants (slug, name, shadow_mode)
         VALUES ($1, $2, false)
         ON CONFLICT (slug) DO NOTHING`,
        [TENANT_SLUG, `Демо-тенант аудита доступа: ${TENANT_SLUG}`],
      );
    } finally {
      await client.end();
    }

    try {
      middlewareModule = (await import(
        /* @vite-ignore */ pathToFileURL(MIDDLEWARE_PATH).href
      )) as MiddlewareModule;
    } catch (error) {
      middlewareLoadError = error instanceof Error ? error.message : String(error);
    }
  });

  beforeEach(async () => {
    process.env.ACCESS_CODE = TEST_CODE;
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.MANAGER_ACCESS_CODE = TEST_MANAGER_CODE;

    // Счётчики чистятся перед каждым тестом: иначе лимит запросов исчерпается
    // на соседнем кейсе.
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `DELETE FROM usage_counters
          WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)`,
        [TENANT_SLUG],
      );
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await closePool();
  });

  describe("A3 — барьер подключён к маршрутам ядра", () => {
    it("барьер существует: src/middleware.ts подключён", () => {
      expect(
        middlewareLoadError,
        `барьер доступа не подключён: ${middlewareLoadError ?? ""}`,
      ).toBeNull();
      expect(typeof middlewareModule?.middleware).toBe("function");
    });

    it("закрывает все маршруты ядра из контракта", () => {
      const matcher = middlewareModule?.config.matcher ?? [];
      // Маршруты ядра по контракту §3 и §11.1: список здесь жёсткий, чтобы
      // новый маршрут нельзя было забыть закрыть.
      for (const path of [
        "/v1/chat",
        "/api/chat",
        "/api/agent/run",
        "/api/kb/search",
        "/api/docs/quote",
      ]) {
        const covered = matcher.some((pattern) => {
          const prefix = pattern.replace(/\/:path\*$/, "");
          return path === prefix || path.startsWith(`${prefix}/`);
        });
        expect(covered, `маршрут ${path} не закрыт middleware`).toBe(true);
      }
    });

    it("список закрытых маршрутов в модуле доступа совпадает с контрактом", () => {
      // На базовой ветке списка ещё нет: проверка падает понятным
      // утверждением, а не ошибкой загрузки модуля.
      const routes = (access.PROTECTED_ROUTES ?? []).map((entry) => entry.path);

      expect(routes).toContain("/v1/chat");
      expect(routes).toContain("/api/chat");
      expect(routes).toContain("/api/agent/run");
      expect(routes).toContain("/api/kb/search");
      expect(routes).toContain("/api/docs");
    });

    it("не пускает в защищённый маршрут без cookie доступа", async () => {
      const response = await callMiddleware(
        nextRequest("/api/chat", { method: "POST", ip: "198.51.100.10" }),
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe("unauthorized");
      expect(typeof body.error.request_id).toBe("string");
    });

    it("middleware отвечает 401 на каждый защищённый маршрут", async () => {
      for (const path of [
        "/v1/chat",
        "/api/chat",
        "/api/agent/run",
        "/api/kb/search",
        "/api/docs/quote",
      ]) {
        const response = await callMiddleware(
          nextRequest(path, { method: "POST", ip: "198.51.100.77" }),
        );
        expect(response.status, `маршрут ${path}`).toBe(401);
      }
    });

    it("middleware пропускает запрос с действующей cookie", async () => {
      const cookie = await issueAccessCookie();

      const response = await callMiddleware(
        nextRequest("/api/chat", {
          method: "POST",
          cookie,
          ip: "198.51.100.78",
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("не выпускает запрос без cookie в ядро ни по одному пути", async () => {
      // Барьер — единственная точка входа: обойти его нельзя ни через
      // публичный путь `/v1/chat`, ни через внутренний `/api/chat`.
      for (const path of ["/v1/chat", "/api/chat"]) {
        const response = await callMiddleware(
          nextRequest(path, { method: "POST", ip: "198.51.100.79" }),
        );
        expect(response.status, `маршрут ${path}`).toBe(401);
      }
    });
  });

  describe("A3 — лимиты стенда", () => {
    it("отклоняет 11-й запрос в минуту с одного IP", async () => {
      const cookie = await issueAccessCookie();
      const dialog = conversationCookie();

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await callMiddleware(
          nextRequest("/api/chat", {
            method: "POST",
            cookie: `${cookie}; ${dialog}`,
            ip: "198.51.100.20",
          }),
        );
        expect(response.status, `запрос ${attempt + 1}`).toBe(200);
      }

      const limited = await callMiddleware(
        nextRequest("/api/chat", {
          method: "POST",
          cookie: `${cookie}; ${dialog}`,
          ip: "198.51.100.20",
        }),
      );

      expect(limited.status).toBe(429);
      const body = await limited.json();
      expect(body.error.code).toBe("rate_limited");
      expect(limited.headers.get("retry-after")).toBeTruthy();
    });

    it("не запускает 51-й диалог за сутки", async () => {
      const cookie = await issueAccessCookie();
      // Лимит запросов по IP поднят: здесь проверяется суточная квота
      // диалогов, а не минутный лимит запросов.
      const previousRate = process.env.REQUESTS_PER_MINUTE;
      process.env.REQUESTS_PER_MINUTE = "1000";
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const response = await callMiddleware(
            nextRequest("/api/chat", {
              method: "POST",
              cookie,
              ip: "198.51.100.30",
            }),
          );
          expect(response.status, `диалог ${attempt + 1}`).toBe(200);
        }

        const response = await callMiddleware(
          nextRequest("/api/chat", {
            method: "POST",
            cookie,
            ip: "198.51.100.30",
          }),
        );

        expect(response.status).toBe(429);
        const body = await response.json();
        expect(body.error.code).toBe("rate_limited");
      } finally {
        if (previousRate === undefined) {
          delete process.env.REQUESTS_PER_MINUTE;
        } else {
          process.env.REQUESTS_PER_MINUTE = previousRate;
        }
      }
    });

    it("не расходует квоту диалогов на запросы внутри начатого диалога", async () => {
      const cookie = await issueAccessCookie();
      const dialog = conversationCookie();
      const previousRate = process.env.REQUESTS_PER_MINUTE;
      process.env.REQUESTS_PER_MINUTE = "1000";
      try {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const response = await callMiddleware(
            nextRequest("/api/chat", {
              method: "POST",
              cookie: `${cookie}; ${dialog}`,
              ip: "198.51.100.31",
            }),
          );
          expect(response.status, `запрос ${attempt + 1}`).toBe(200);
        }

        const daily = await checkDailyDialogs();
        expect(daily.allowed).toBe(true);
      } finally {
        if (previousRate === undefined) {
          delete process.env.REQUESTS_PER_MINUTE;
        } else {
          process.env.REQUESTS_PER_MINUTE = previousRate;
        }
      }
    });

    it("останавливает запросы при исчерпанном бюджете модели", async () => {
      const cookie = await issueAccessCookie();
      await recordModelSpend(30);

      const response = await callMiddleware(
        nextRequest("/api/chat", {
          method: "POST",
          cookie,
          ip: "198.51.100.40",
        }),
      );

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error.message).toContain("Лимит демо исчерпан");
    });
  });

  describe("A2 — страница доступа и маршрут входа", () => {
    it("маршрут принимает JSON — страница шлёт JSON через fetch", async () => {
      const response = await postAccess({ code: TEST_CODE });

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(`${ACCESS_COOKIE}=`);
    });

    it("маршрут принимает и обычную форму", async () => {
      const response = await postAccess(TEST_CODE, true);

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(`${ACCESS_COOKIE}=`);
    });

    it("форма страницы выдаёт рабочую cookie сессии", async () => {
      // Запрос уходит ровно так, как его отправляет страница: JSON через
      // `fetch` с телом `{ code }`.
      const response = await postAccess({ code: TEST_CODE });

      expect(response.status).toBe(200);
      const cookie = `${ACCESS_COOKIE}=${cookieValue(response.headers.get("set-cookie"))}`;
      const session = access.readAccessSession(cookie);
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBeTruthy();
      expect(session?.expiresAt).toBeGreaterThan(Date.now());
    });

    it("страница отправляет код через fetch, а не нативной формой", async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ session_id: "x", expires_at: "y" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      try {
        const AccessForm = await loadAccessForm();
        const { container } = render(createElement(AccessForm));
        const form = container.querySelector("form");
        expect(form).not.toBeNull();
        // Нативная отправка страницы перезагрузила бы её и ушла с
        // form-urlencoded; барьер ждёт JSON.
        expect(form?.getAttribute("action")).toBeNull();
        expect(form?.getAttribute("method")).toBeNull();

        const input = container.querySelector("input[name=code]");
        expect(input).not.toBeNull();
        if (!(input instanceof HTMLInputElement)) {
          throw new Error("поле ввода кода не найдено");
        }
        input.value = TEST_CODE;

        await fireEvent.submit(form as HTMLFormElement);

        await waitFor(() => {
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("/api/access");
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ code: TEST_CODE });
        expect((init.headers as Record<string, string>)["content-type"]).toBe(
          "application/json",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("код доступа не попадает в разметку страницы", async () => {
      const { container } = render(createElement(AccessPage));

      expect(container.innerHTML).not.toContain(TEST_CODE);
      expect(container.innerHTML).not.toContain(TEST_MANAGER_CODE);
      expect(container.innerHTML).not.toContain(TEST_SECRET);
    });

    it("код доступа не попадает в ответы API", async () => {
      const denied = await postAccess({ code: "wrong-code" });
      const allowed = await postAccess({ code: TEST_CODE });

      for (const response of [denied, allowed]) {
        const text = `${JSON.stringify(await response.clone().json())}${
          response.headers.get("set-cookie") ?? ""
        }`;
        expect(text).not.toContain(TEST_CODE);
        expect(text).not.toContain(TEST_SECRET);
      }
    });
  });

  describe("A3 — кабинет менеджера", () => {
    it("не пускает в кабинет без кода менеджера", async () => {
      const response = await postAccess({ code: TEST_CODE, manager: true });

      // Код стенда в кабинет менеджера не подходит (R17).
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("не пускает в кабинет, если MANAGER_ACCESS_CODE не задан", async () => {
      delete process.env.MANAGER_ACCESS_CODE;

      const response = await postAccess({ code: TEST_MANAGER_CODE, manager: true });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe("forbidden");
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("выдаёт отдельную cookie кабинета по коду менеджера", async () => {
      const response = await postAccess({ code: TEST_MANAGER_CODE, manager: true });

      expect(response.status).toBe(200);
      const setCookie = response.headers.get("set-cookie") as string;
      expect(setCookie).toContain(`${MANAGER_COOKIE}=`);
      // Cookie стенда кабинету не подходит.
      expect(access.readManagerSession(`${ACCESS_COOKIE}=${cookieValue(setCookie)}`)).toBeNull();

      const session = access.readManagerSession(
        `${MANAGER_COOKIE}=${cookieValue(setCookie)}`,
      );
      expect(session).not.toBeNull();
    });

    it("не пускает в кабинет по cookie стенда", async () => {
      const accessCookie = await issueAccessCookie();

      const decision = await access.checkManagerAccess({ cookieHeader: accessCookie });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("missing_code");
    });
  });
});
