/**
 * Живой прогон среза 03: загрузка, вопрос до одобрения, одобрение, повторный
 * вопрос, отказ по формату.
 *
 * Скрипт поднимает настоящий HTTP-сервер поверх маршрутов среза и проходит
 * сценарий клиентскими запросами: коды ответов, multipart-разбор, запись в
 * базу и агентный цикл — всё настоящее. Отличается только обвязка Next.js:
 * dev-сервер не собирает маршруты с `pg` в этой среде (ошибка есть и в
 * соседних срезах, и в главном дереве), поэтому запросы разбираются
 * стандартным модулем `http`.
 *
 * Вопрос задаётся ядру напрямую: HTTP-маршрут чата на этой ветке не
 * проходит миграцию соседнего среза (в `escalations` нет колонки `channel`),
 * и это не связано со срезом 03. Ядро при этом то же: тот же поиск, тот же
 * валидатор, тот же `stripUrls`.
 *
 * Секреты в вывод не попадают: печатаются коды ответов, идентификаторы
 * документов и выдержки из выдачи.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { AddressInfo } from "node:net";

import { POST as uploadRoute } from "@/app/api/kb/documents/route";
import { POST as approveRoute } from "@/app/api/kb/documents/[id]/approve/route";
import { GET as searchRoute } from "@/app/api/kb/search/route";
import { runAgent } from "@/core/run";
import { getTenantId } from "@/db/tenant";

const SESSION_SECRET = process.env["SESSION_SECRET"] ?? "";
const MANAGER_CODE = process.env["MANAGER_ACCESS_CODE"] ?? "";
const PORT = Number(process.env["LIVE_PORT"] ?? 3110);

/**
 * Подписанная cookie кабинета менеджера.
 *
 * Сессия собирается тем же способом, что и в модуле доступа: подпись
 * HMAC-SHA256 от кода и секрета, cookie перехватывает барьер кабинета.
 */
function managerCookie(): string {
  const digest = createHmac("sha256", SESSION_SECRET).update(MANAGER_CODE, "utf8").digest("hex");
  const expiresAt = Date.now() + 3_600_000;
  const payload = Buffer.from(`live-manager.${expiresAt}`, "utf8").toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET)
    .update(`live-manager.${expiresAt}.${digest}`, "utf8")
    .digest("base64url");
  return `support_manager=${payload}.${signature}`;
}

/**
 * Тело запроса: multipart-разбор собирает данные в памяти.
 *
 * Возвращается `ArrayBuffer`, а не `Buffer`: тело `Request` принимает
 * `BodyInit`, в который `Buffer` из Node не входит по типам.
 */
async function readBody(request: IncomingMessage): Promise<ArrayBuffer> {
  const parts: Buffer[] = [];
  for await (const part of request) {
    parts.push(part as Buffer);
  }
  const joined = Buffer.concat(parts);
  const bytes = new Uint8Array(joined.byteLength);
  bytes.set(joined);
  return bytes.buffer;
}

/** Запуск сервера поверх маршрутов среза. */
async function startServer(): Promise<string> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const body = await readBody(request);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }

    const webRequest = new Request(url, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    });

    let result: Response;
    if (url.pathname === "/api/kb/documents" && request.method === "POST") {
      result = await uploadRoute(webRequest);
    } else if (url.pathname.endsWith("/approve") && request.method === "POST") {
      const id = url.pathname.split("/").at(-2) ?? "";
      result = await approveRoute(webRequest, { params: Promise.resolve({ id }) });
    } else if (url.pathname === "/api/kb/search" && request.method === "GET") {
      result = await searchRoute(webRequest);
    } else {
      result = Response.json({ error: { code: "not_found" } }, { status: 404 });
    }

    const payload = Buffer.from(await result.arrayBuffer());
    response.writeHead(result.status, {
      "content-type": result.headers.get("content-type") ?? "application/json",
    });
    response.end(payload);
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Синтетический документ.
 *
 * Тема выбрана так, чтобы её не было в импортированной базе знаний сайта:
 * иначе до одобрения агент нашёл бы статью сайта и ответ по ней, а не
 * «нет в базе», и проверка видимости документа была бы неочевидной.
 *
 * Числа записаны цифрами: валидатор ответа сверяет числа модели с числами
 * источника, и «3 рабочих дня» словами в цитату не попало бы.
 */
const DOCUMENT_TEXT = [
  "Внутренний регламент приёма заявок на выдачу демонстрационных образцов в офисе номер 7.",
  "Заявка на демонстрационный образец принимается по будням с 10 до 15 часов.",
  "Демонстрационный образец выдаётся на 3 рабочих дня и возвращается с актом подписи.",
  "Если заявка поступает в нерабочее время, она попадает в очередь на следующий рабочий день.",
  "Ответственный сотрудник офиса номер 7 подтверждает выдачу образца в тот же день.",
].join(" ");

const LONG_TEXT = `${DOCUMENT_TEXT} ${DOCUMENT_TEXT} ${DOCUMENT_TEXT}`;
const QUESTION = "Каков порядок приёма заявок на выдачу демонстрационных образцов в офисе номер семь?";

async function main(): Promise<void> {
  const base = await startServer();
  const tenantId = await getTenantId();
  console.log(`Сервер живых маршрутов: ${base}`);
  console.log(`Арендатор: ${tenantId}\n`);

  console.log("=== 1. Загрузка синтетического документа (менеджер) ===");
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(Buffer.from(LONG_TEXT, "utf8"))], "reglament-live.txt", {
      type: "text/plain",
    }),
  );
  const uploadResponse = await fetch(`${base}/api/kb/documents`, {
    method: "POST",
    headers: { cookie: managerCookie() },
    body: form,
  });
  const uploaded = (await uploadResponse.json()) as Record<string, unknown>;
  console.log(`HTTP ${uploadResponse.status}`);
  console.log(JSON.stringify(uploaded, null, 2));

  const documentId = String(uploaded["id"]);

  console.log("\n=== 2. Поиск до одобрения ===");
  const searchBefore = await fetch(
    `${base}/api/kb/search?q=${encodeURIComponent(QUESTION)}`,
  );
  const beforeBody = (await searchBefore.json()) as { matches: Array<Record<string, unknown>> };
  console.log(`HTTP ${searchBefore.status}, совпадений: ${beforeBody.matches.length}`);
  const leaked = beforeBody.matches.find((match) => match["article_id"] === documentId);
  console.log(`загруженный документ в выдаче: ${leaked !== undefined}`);

  console.log("\n=== 3. Вопрос до одобрения ===");
  const before = await runAgent({
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    channel: "web",
    externalChatId: null,
    text: QUESTION,
    maskedFieldsCount: 0,
    tenantId,
  });
  reportOutcome(before, documentId);

  console.log("\n=== 4. Одобрение менеджером ===");
  const approveResponse = await fetch(`${base}/api/kb/documents/${documentId}/approve`, {
    method: "POST",
    headers: { cookie: managerCookie(), "content-type": "application/json" },
    body: JSON.stringify({ actor: "live-manager" }),
  });
  console.log(`HTTP ${approveResponse.status}`);
  console.log(JSON.stringify(await approveResponse.json(), null, 2));

  console.log("\n=== 5. Поиск после одобрения ===");
  const searchAfter = await fetch(
    `${base}/api/kb/search?q=${encodeURIComponent(QUESTION)}`,
  );
  const afterBody = (await searchAfter.json()) as { matches: Array<Record<string, unknown>> };
  console.log(`HTTP ${searchAfter.status}, совпадений: ${afterBody.matches.length}`);
  const found = afterBody.matches.find((match) => match["article_id"] === documentId);
  console.log(`загруженный документ в выдаче: ${found !== undefined}`);
  if (found) {
    console.log(JSON.stringify(found, null, 2));
  }

  console.log("\n=== 6. Повторный вопрос после одобрения ===");
  const after = await runAgent({
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    channel: "web",
    externalChatId: null,
    text: QUESTION,
    maskedFieldsCount: 0,
    tenantId,
  });
  reportOutcome(after, documentId);

  console.log("\n=== 7. Неподдерживаемый формат ===");
  const badForm = new FormData();
  badForm.set(
    "file",
    new File([new Uint8Array(Buffer.from("MZ binary", "utf8"))], "installer-live.exe", {
      type: "application/octet-stream",
    }),
  );
  const badUpload = await fetch(`${base}/api/kb/documents`, {
    method: "POST",
    headers: { cookie: managerCookie() },
    body: badForm,
  });
  console.log(`HTTP ${badUpload.status}`);
  console.log(JSON.stringify(await badUpload.json(), null, 2));

  console.log("\n=== 8. Повторное одобрение ===");
  const second = await fetch(`${base}/api/kb/documents/${documentId}/approve`, {
    method: "POST",
    headers: { cookie: managerCookie(), "content-type": "application/json" },
    body: JSON.stringify({ actor: "live-manager" }),
  });
  console.log(`HTTP ${second.status}`);
  console.log(JSON.stringify(await second.json(), null, 2));

  console.log("\n=== 9. Загрузка без cookie менеджера ===");
  const anonymousForm = new FormData();
  anonymousForm.set(
    "file",
    new File([new Uint8Array(Buffer.from(LONG_TEXT, "utf8"))], "anon.txt", {
      type: "text/plain",
    }),
  );
  const anonymous = await fetch(`${base}/api/kb/documents`, {
    method: "POST",
    body: anonymousForm,
  });
  console.log(`HTTP ${anonymous.status}`);
  console.log(JSON.stringify(await anonymous.json(), null, 2));

  console.log(`\nИдентификатор синтетического документа: ${documentId}`);
  // Сервер живых маршрутов держит процесс: без выхода скрипт не завершится.
  process.exit(0);
}

/** Печать исхода агентного цикла: источники, текст и наличие URL. */
function reportOutcome(
  outcome: Awaited<ReturnType<typeof runAgent>>,
  documentId: string,
): void {
  if (outcome.outcome !== "respond") {
    console.log(`Исход: ${outcome.outcome}, причина: ${outcome.escalation?.reason ?? "—"}`);
    console.log(`источник загруженного документа в ответе: false`);
    return;
  }

  const documentSource = outcome.answer.sources.find((source) => source.id === documentId);
  console.log(`Исход: respond, источников: ${outcome.answer.sources.length}`);
  console.log(`источник загруженного документа в ответе: ${documentSource !== undefined}`);
  if (documentSource) {
    console.log(JSON.stringify(documentSource, null, 2));
  }
  console.log(`текст ответа: ${outcome.answer.text}`);
  console.log(`в тексте есть http(s): ${/https?:\/\//iu.test(outcome.answer.text)}`);
}

await main();
