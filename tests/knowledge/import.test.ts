import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { crawlSite, extractPage } from "@/import/knowledge";

type Route = {
  status: number;
  body: string;
  /** Метка для проверки порядка и частоты запросов. */
  tag: string;
};

type Recorded = {
  path: string;
  at: number;
  userAgent: string | undefined;
};

function page(title: string, body: string, sectionPath: string[]): string {
  return `<!doctype html><html><head><title>${title} — База Знаний</title></head><body>
<header class="header"><span>Домой</span></header>
<article class="article">
  <div class="breadcrumbs__wrap">${sectionPath
    .map((s) => `<div class="breadcrumbs__link">${s}</div>`)
    .join("")}</div>
  <h1>${title}</h1>
  <div class="content">${body}</div>
</article>
<footer class="footer">Служебный текст подвала</footer>
<script>var x = 1;</script>
</body></html>`;
}

/** Локальный сайт-заглушка: отдаёт заданные ответы по путям. */
async function startSite(routes: Map<string, Route>): Promise<{
  server: Server;
  baseUrl: string;
  requests: Recorded[];
}> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push({ path, at: Date.now(), userAgent: req.headers["user-agent"] });
    const route = routes.get(path);
    if (!route) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>404</body></html>");
      return;
    }
    res.writeHead(route.status, { "content-type": "text/html; charset=utf-8" });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}

function stopSite(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("extractPage", () => {
  it("достаёт заголовок, путь разделов и основной текст", () => {
    const html = page(
      "Как войти в аккаунт",
      "<p>Откройте страницу входа.</p><p>Введите логин и пароль.</p>",
      ["Softline ID", "Авторизация"],
    );
    const extracted = extractPage(html, "https://docs.softline.com/ru-ru/id/login");

    expect(extracted.title).toBe("Как войти в аккаунт");
    expect(extracted.sectionPath).toBe("Softline ID / Авторизация");
    expect(extracted.text).toContain("Откройте страницу входа.");
    expect(extracted.text).toContain("Введите логин и пароль.");
    expect(extracted.url).toBe("https://docs.softline.com/ru-ru/id/login");
  });

  it("выбрасывает разметку, скрипты и служебные блоки", () => {
    const html = page(
      "Заголовок",
      "<p>Текст статьи.</p>",
      ["Раздел"],
    );
    const extracted = extractPage(html, "https://docs.softline.com/ru-ru/id/x");

    expect(extracted.text).not.toContain("<p>");
    expect(extracted.text).not.toContain("var x = 1");
    expect(extracted.text).not.toContain("Служебный текст подвала");
  });
});

describe("crawlSite", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "kb-crawl-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("обходит в ширину, дедуплицирует URL и соблюдает глубину", async () => {
    const routes = new Map<string, Route>([
      [
        "/root/",
        {
          status: 200,
          tag: "root",
          body: page("Корень", `<p>Корень.</p><a href="/a/">A</a><a href="/a/">A again</a>`, ["Раздел"]),
        },
      ],
      [
        "/a/",
        {
          status: 200,
          tag: "a",
          body: page("A", `<p>A.</p><a href="/a/b/">AB</a>`, ["Раздел"]),
        },
      ],
      [
        "/a/b/",
        {
          status: 200,
          tag: "ab",
          body: page("AB", `<p>AB.</p><a href="/a/b/c/">ABC</a>`, ["Раздел"]),
        },
      ],
      [
        "/a/b/c/",
        {
          status: 200,
          tag: "abc",
          body: page("ABC", `<p>ABC.</p>`, ["Раздел"]),
        },
      ],
    ]);
    const { server, baseUrl, requests } = await startSite(routes);

    const report = await crawlSite({
      roots: [`${baseUrl}/root/`],
      maxDepth: 2,
      delayMs: 0,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 30_000,
    });

    await stopSite(server);

    expect(report.stoppedReason).toBe("completed");
    expect(report.visited).toBe(3);
    // /a/b/c/ — глубина 3, при maxDepth=2 не обходится.
    expect(requests.map((r) => r.path)).not.toContain("/a/b/c/");
    // /a/ запрошен один раз, несмотря на две ссылки на него.
    expect(requests.filter((r) => r.path === "/a/")).toHaveLength(1);
    expect(report.pages.map((p) => p.url).sort()).toEqual([
      `${baseUrl}/a/`,
      `${baseUrl}/a/b/`,
      `${baseUrl}/root/`,
    ]);
  });

  it("останавливается при 429 с причиной и сохраняет собранное", async () => {
    const routes = new Map<string, Route>([
      ["/root/", { status: 200, tag: "root", body: page("Корень", "<p>Есть текст.</p>", ["Раздел"]) }],
      ["/next/", { status: 429, tag: "next", body: "Too many requests" }],
    ]);
    const { server, baseUrl } = await startSite(routes);

    const report = await crawlSite({
      roots: [`${baseUrl}/root/`, `${baseUrl}/next/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 30_000,
    });

    await stopSite(server);

    expect(report.stoppedReason).toBe("rate_limited");
    expect(report.pages.length).toBeGreaterThanOrEqual(1);
    expect(report.pages[0]?.text).toContain("Есть текст.");
  });

  it("останавливается при 5xx с причиной server_error", async () => {
    const routes = new Map<string, Route>([
      ["/root/", { status: 200, tag: "root", body: page("Корень", "<p>Есть текст.</p>", ["Раздел"]) }],
      ["/next/", { status: 503, tag: "next", body: "Service Unavailable" }],
    ]);
    const { server, baseUrl } = await startSite(routes);

    const report = await crawlSite({
      roots: [`${baseUrl}/root/`, `${baseUrl}/next/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 30_000,
    });

    await stopSite(server);

    expect(report.stoppedReason).toBe("server_error");
    expect(report.pages.length).toBeGreaterThanOrEqual(1);
  });

  it("повторный запуск берёт кэш и не обращается к сайту", async () => {
    const routes = new Map<string, Route>([
      ["/root/", { status: 200, tag: "root", body: page("Корень", "<p>Текст из кэша.</p>", ["Раздел"]) }],
    ]);
    const { server, baseUrl, requests } = await startSite(routes);

    const first = await crawlSite({
      roots: [`${baseUrl}/root/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 30_000,
    });
    const requestsAfterFirst = requests.length;

    const second = await crawlSite({
      roots: [`${baseUrl}/root/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 30_000,
    });

    await stopSite(server);

    expect(first.visited).toBe(1);
    expect(second.cached).toBe(1);
    expect(second.visited).toBe(0);
    expect(requests).toHaveLength(requestsAfterFirst);
    expect(second.pages[0]?.text).toContain("Текст из кэша.");
  });

  it("между запросами проходит не меньше заданной паузы", async () => {
    const routes = new Map<string, Route>([
      ["/root/", { status: 200, tag: "root", body: page("Корень", `<p>Корень.</p><a href="/a/">A</a>`, ["Раздел"]) }],
      ["/a/", { status: 200, tag: "a", body: page("A", "<p>A.</p>", ["Раздел"]) }],
    ]);
    const { server, baseUrl, requests } = await startSite(routes);

    await crawlSite({
      roots: [`${baseUrl}/root/`],
      maxDepth: 1,
      delayMs: 300,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 30_000,
    });

    await stopSite(server);

    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < requests.length; i += 1) {
      const previous = requests[i - 1];
      const current = requests[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(current!.at - previous!.at).toBeGreaterThanOrEqual(250);
    }
  });

  it("отправляет понятный User-Agent с контактом", async () => {
    const routes = new Map<string, Route>([
      ["/root/", { status: 200, tag: "root", body: page("Корень", "<p>Текст.</p>", ["Раздел"]) }],
    ]);
    const { server, baseUrl, requests } = await startSite(routes);

    await crawlSite({
      roots: [`${baseUrl}/root/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "SoftlineSupportBot/1.0 (+https://github.com/ai4bordon/aisupport)",
      cacheDir,
      timeBudgetMs: 30_000,
    });

    await stopSite(server);

    const agent = requests[0]?.userAgent ?? "";
    expect(agent).toContain("SoftlineSupportBot");
    expect(agent).toContain("aisupport");
  });

  it("останавливается по таймбоксу", async () => {
    const routes = new Map<string, Route>([
      ["/root/", { status: 200, tag: "root", body: page("Корень", `<p>Корень.</p><a href="/a/">A</a>`, ["Раздел"]) }],
      ["/a/", { status: 200, tag: "a", body: page("A", "<p>A.</p>", ["Раздел"]) }],
    ]);
    const { server, baseUrl } = await startSite(routes);

    const report = await crawlSite({
      roots: [`${baseUrl}/root/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 1,
    });

    await stopSite(server);

    expect(report.stoppedReason).toBe("time_budget");
  });

  it("сохраняет сырой HTML в кэш на диск", async () => {
    const routes = new Map<string, Route>([
      ["/root/", { status: 200, tag: "root", body: page("Корень", "<p>Текст.</p>", ["Раздел"]) }],
    ]);
    const { server, baseUrl } = await startSite(routes);

    const report = await crawlSite({
      roots: [`${baseUrl}/root/`],
      maxDepth: 1,
      delayMs: 0,
      userAgent: "TestBot/1.0 (+contact@example.com)",
      cacheDir,
      timeBudgetMs: 30_000,
    });

    await stopSite(server);

    const files = await readdir(cacheDir, { recursive: true });
    expect(files.length).toBeGreaterThan(0);
    const htmlFiles = files.filter((f) => String(f).endsWith(".html"));
    expect(htmlFiles.length).toBeGreaterThan(0);
    const raw = await readFile(join(cacheDir, String(htmlFiles[0])), "utf8");
    expect(raw).toContain("<h1>Корень</h1>");
    expect(report.pages[0]?.rawHtmlPath).toContain(cacheDir);
  });
});
