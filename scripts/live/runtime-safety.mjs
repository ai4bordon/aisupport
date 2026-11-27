#!/usr/bin/env node
// Живой прогон среза 10: устойчивость и безопасность ядра.
//
// Запуск:
//   DATABASE_URL=... OPENCODE_API_KEY=... node scripts/live/runtime-safety.mjs
//
// Что проверяется:
//   1. веб-чат получает сообщение с тестовыми email, телефоном и ФИО:
//      в захваченном запросе модели видны только метки, клиент получает
//      свои же данные;
//   2. MAX получает то же сообщение — то же самое, а необработанное ПД в
//      ответе наружу не уходит;
//   3. подготовленный 429 даёт ровно один повтор и эскалацию;
//   4. тайм-аут первого токена даёт upstream_timeout;
//   5. конкурентные ходы одного диалога не теряют записи.
//
// Живой провайдер модели используется через локальный прокси-захватчик:
//      прокси записывает тела запросов и пересылает их настоящему
//      провайдеру. Для сценариев 429 и тайм-аута провайдер подменяется
//      заглушкой: боевую конфигурацию живого стенда это не меняет.
//
// Свидетельства печатаются без секретов и без исходных персональных
// данных: показываются только метки и факты.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Значения тестового клиента. Настоящих персональных данных здесь нет,
 * и в вывод они не печатаются: свидетельство — метки и факты.
 */
const CLIENT = {
  email: "ivanov@example.test",
  phone: "+7 900 123-45-67",
  name: "Иван Иванович Иванов",
};

/** Чужое значение: его в ответе быть не должно. */
const LEAKED = "petrov@example.test";

const baseUrl = process.env.RUNTIME_BASE_URL ?? "http://127.0.0.1:3010";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL не задан");
  process.exit(2);
}

/** Настоящий провайдер модели: адрес и ключ из окружения. */
const liveProviderUrl = process.env.OPENCODE_BASE_URL ?? "";
const liveProviderKey = process.env.OPENCODE_API_KEY ?? "";

const pg = (await import("pg")).default;
const pool = new pg.Client({ connectionString: databaseUrl });
await pool.connect();

/** Захваченные тела запросов к провайдеру модели. */
const capturedRequests = [];
let providerCalls = 0;

/** Режим провайдера: `live` — настоящий, `429`, `timeout`, `leak`. */
let mode = "live";

/**
 * Прокси-захватчик перед провайдером модели.
 *
 * Тела запросов записываются и пересылаются настоящему провайдеру: живой
 * вызов остаётся живым, а свидетельство — в захваченных телах.
 */
const captureProxy = createServer((req, res) => {
  providerCalls += 1;
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", async () => {
    if (mode === "429") {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("busy");
      return;
    }
    if (mode === "timeout") {
      // Ответа нет: соединение держится, пока прокси не закроет его.
      return;
    }
    if (mode === "leak") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `Свяжитесь с ${LEAKED}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
      return;
    }
    capturedRequests.push(body);
    try {
      const upstream = await fetch(`${liveProviderUrl}${req.url}`, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
          authorization: `Bearer ${liveProviderKey}`,
          "x-opencode-session": req.headers["x-opencode-session"] ?? "live-session",
        },
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(text);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
});

await new Promise((resolve) => captureProxy.listen(8099, "127.0.0.1", resolve));
console.log(`Прокси-захватчик провайдера модели: http://127.0.0.1:8099 (режим: ${mode})`);

/** Заглушка Bot API MAX: считает вызовы `POST /messages`. */
let maxSentCalls = 0;
const maxSent = [];
let maxUpdates = [];

const maxStub = createServer((req, res) => {
  if (req.method === "POST" && (req.url ?? "").startsWith("/messages")) {
    maxSentCalls += 1;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      maxSent.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { mid: `stub-${maxSentCalls}` } }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ updates: maxUpdates, marker: 1 }));
});

await new Promise((resolve) => maxStub.listen(8098, "127.0.0.1", resolve));
console.log("Заглушка Bot API MAX: http://127.0.0.1:8098");

/** Событие MAX с сообщением клиента. */
function maxUpdate(text) {
  return {
    update_type: "message_created",
    timestamp: Date.now(),
    message: {
      body: { mid: `live-${randomUUID()}`, text },
      recipient: { chat_id: 4242 },
    },
  };
}

/** Текст сообщения клиента с тестовыми персональными данными. */
function clientText() {
  return `Меня зовут ${CLIENT.name}, почта ${CLIENT.email}, телефон ${CLIENT.phone}. Как получить электронную лицензию?`;
}

/** Есть ли в захваченных запросах исходное значение клиента. */
function leaksClientValues() {
  const bodies = capturedRequests.join("\n");
  return (
    bodies.includes(CLIENT.email) ||
    bodies.includes(CLIENT.phone) ||
    bodies.includes(CLIENT.name)
  );
}

/** Запрос к веб-чату. */
async function chat(conversationId, clientMessageId, text) {
  const response = await fetch(`${baseUrl}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversation_id: conversationId,
      message: { client_message_id: clientMessageId, text },
    }),
  });
  return { status: response.status, body: await response.json() };
}

/** Запуск воркера MAX против заглушки Bot API. */
function startMaxWorker(providerUrl) {
  return spawn(
    process.execPath,
    ["--import", "tsx", "scripts/max-worker.ts"],
    {
      env: {
        ...process.env,
        MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN ?? "LIVE-STUB-TOKEN",
        MAX_BASE_URL: "http://127.0.0.1:8098",
        CORE_BASE_URL: baseUrl,
        OPENCODE_BASE_URL: providerUrl,
        DATABASE_URL: databaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

const results = [];

try {
  // ── Сценарий 1: веб-чат с персональными данными ────────────────────
  console.log("\nЖИВОЙ ПРОГОН 1: веб-чат, вход с тестовыми ПД");
  capturedRequests.length = 0;
  providerCalls = 0;
  mode = "live";

  const webResult = await chat(randomUUID(), randomUUID(), clientText());

  const webLeaks = leaksClientValues();
  const webHasLabels = capturedRequests.join("\n").includes("⟦");
  console.log(`  HTTP ${webResult.status}, outcome=${webResult.body.outcome}`);
  console.log(`  вызовов провайдера: ${providerCalls}`);
  console.log(`  в запросе модели есть метки: ${webHasLabels}`);
  console.log(`  в запросе модели есть исходные значения клиента: ${webLeaks}`);
  console.log(
    `  ответ клиенту содержит адрес клиента: ${String(webResult.body.answer?.text ?? "").includes(CLIENT.email)}`,
  );
  console.log(
    `  в ответе клиенту остались метки: ${String(webResult.body.answer?.text ?? "").includes("⟦")}`,
  );
  results.push({
    scenario: "веб-чат: в модель уходят только метки",
    ok: webHasLabels && !webLeaks,
  });

  // ── Сценарий 2: MAX с персональными данными ────────────────────────
  console.log("\nЖИВОЙ ПРОГОН 2: MAX, вход с тестовыми ПД");
  capturedRequests.length = 0;
  providerCalls = 0;
  maxSentCalls = 0;
  maxSent.length = 0;
  mode = "live";

  maxUpdates = [maxUpdate(clientText())];
  const worker = startMaxWorker("http://127.0.0.1:8099");
  for (let attempt = 0; attempt < 60 && maxSentCalls === 0; attempt += 1) {
    await sleep(1000);
  }
  worker.kill();

  const maxLeaks = leaksClientValues();
  const maxHasLabels = capturedRequests.join("\n").includes("⟦");
  console.log(`  вызовов провайдера: ${providerCalls}`);
  console.log(`  отправок в MAX: ${maxSentCalls}`);
  console.log(`  в запросе модели есть метки: ${maxHasLabels}`);
  console.log(`  в запросе модели есть исходные значения клиента: ${maxLeaks}`);
  console.log(
    `  в отправленном сообщении есть исходные значения клиента: ${maxSent.some((body) => body.includes(CLIENT.email) || body.includes(CLIENT.name))}`,
  );
  results.push({
    scenario: "MAX: в модель уходят только метки",
    ok: maxHasLabels && !maxLeaks,
  });

  // ── Сценарий 3: необработанное ПД в ответе MAX не отправляется ──────
  console.log("\nЖИВОЙ ПРОГОН 3: MAX, необработанное ПД в ответе");
  maxSentCalls = 0;
  maxSent.length = 0;
  capturedRequests.length = 0;
  mode = "leak";

  maxUpdates = [maxUpdate(clientText())];
  const leakWorker = startMaxWorker("http://127.0.0.1:8099");
  // Ждём, пока воркер отработает: отправки быть не должно, поэтому
  // ждём по таймеру.
  await sleep(20_000);
  leakWorker.kill();

  console.log(`  отправок в MAX: ${maxSentCalls}`);
  console.log(
    `  чужое значение в отправленном сообщении: ${maxSent.some((body) => body.includes(LEAKED))}`,
  );
  results.push({
    scenario: "MAX: утечка в ответе не отправляется",
    ok: maxSentCalls === 0,
  });

  // ── Сценарий 4: повтор после 429 ───────────────────────────────────
  console.log("\nЖИВОЙ ПРОГОН 4: подготовленный 429");
  capturedRequests.length = 0;
  providerCalls = 0;
  mode = "429";

  const busyResult = await chat(randomUUID(), randomUUID(), clientText());
  console.log(`  вызовов провайдера: ${providerCalls}`);
  console.log(`  HTTP ${busyResult.status}, outcome=${busyResult.body.outcome}`);
  console.log(`  причина эскалации: ${busyResult.body.escalation?.reason}`);
  console.log(`  ответ клиенту: ${busyResult.body.answer === null ? "нет" : "есть"}`);
  results.push({
    scenario: "429: ровно один повтор и эскалация",
    ok:
      providerCalls === 2 &&
      busyResult.body.outcome === "escalate" &&
      busyResult.body.answer === null,
  });

  // ── Сценарий 5: тайм-аут первого токена ────────────────────────────
  console.log("\nЖИВОЙ ПРОГОН 5: тайм-аут первого токена");
  capturedRequests.length = 0;
  providerCalls = 0;
  mode = "timeout";

  const timeoutResult = await chat(randomUUID(), randomUUID(), clientText());
  console.log(`  вызовов провайдера: ${providerCalls}`);
  console.log(`  HTTP ${timeoutResult.status}, outcome=${timeoutResult.body.outcome}`);
  console.log(`  причина эскалации: ${timeoutResult.body.escalation?.reason}`);
  console.log(`  ответ клиенту: ${timeoutResult.body.answer === null ? "нет" : "есть"}`);
  results.push({
    scenario: "тайм-аут: upstream_timeout без ответа",
    ok:
      timeoutResult.body.outcome === "escalate" &&
      timeoutResult.body.escalation?.reason === "upstream_timeout" &&
      timeoutResult.body.answer === null,
  });

  // ── Сценарий 6: конкурентные ходы одного диалога ───────────────────
  console.log("\nЖИВОЙ ПРОГОН 6: конкурентные ходы одного диалога");
  mode = "live";
  const concurrentConversation = randomUUID();
  await Promise.all([
    chat(concurrentConversation, randomUUID(), "Как получить электронную лицензию?"),
    chat(concurrentConversation, randomUUID(), "Сколько стоит лицензия?"),
  ]);

  const messages = await pool.query(
    "SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND role = 'client'",
    [concurrentConversation],
  );
  const steps = await pool.query(
    "SELECT count(*)::text AS count, count(DISTINCT step_key)::text AS keys FROM agent_steps WHERE conversation_id = $1",
    [concurrentConversation],
  );
  const clientCount = Number(messages.rows[0]?.count ?? "0");
  const stepCount = Number(steps.rows[0]?.count ?? "0");
  const keyCount = Number(steps.rows[0]?.keys ?? "0");
  console.log(`  клиентских сообщений: ${clientCount} (ожидается 2)`);
  console.log(`  шагов трассы: ${stepCount}, различных ключей: ${keyCount}`);
  results.push({
    scenario: "конкурентные ходы: обе записи на месте",
    ok: clientCount === 2 && stepCount === keyCount,
  });

  // ── Свод ────────────────────────────────────────────────────────────
  console.log("\nСВОД ЖИВОГО ПРОГОНА");
  for (const result of results) {
    console.log(`  ${result.ok ? "OK   " : "ПРОВАЛ"} ${result.scenario}`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`  провалов: ${failed.length}`);
  await pool.end();
  process.exit(failed.length === 0 ? 0 : 1);
} finally {
  captureProxy.close();
  maxStub.close();
}
