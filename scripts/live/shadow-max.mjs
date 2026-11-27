#!/usr/bin/env node
// Живой прогон режима тени в MAX: поднимается заглушка Bot API, которая
// считает вызовы POST /messages, и воркер MAX против неё.
//
// Доказательство отсутствия отправки — счётчик вызовов заглушки, а не
// отсутствие видимого текста.
//
// Запуск: DATABASE_URL=... MAX_BOT_TOKEN=... node scripts/live/shadow-max.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.MAX_BOT_TOKEN ?? "LIVE-SHADOW-TOKEN";
const baseUrl = process.env.SHADOW_BASE_URL ?? "http://127.0.0.1:3000";
if (!databaseUrl) {
  console.error("DATABASE_URL не задан");
  process.exit(2);
}

const pg = (await import("pg")).default;
const pool = new pg.Client({ connectionString: databaseUrl });
await pool.connect();

/** Счётчик вызовов `POST /messages` — главное свидетельство прогона. */
let sentCalls = 0;
let marker = 500;

const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/updates") {
      const batch = [
        {
          update_type: "message_created",
          timestamp: Date.now(),
          message: {
            body: { mid: `mid-live-${marker}`, text: "Как получить электронную лицензию?" },
            recipient: { chat_id: 424242 },
          },
        },
      ];
      marker += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ updates: batch, marker }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      sentCalls += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { body: { mid: "sent-mid" } } }));
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: "not.found" }));
  });
});

await new Promise((resolve) => stub.listen(8099, "127.0.0.1", resolve));
console.log("Заглушка Bot API MAX: http://127.0.0.1:8099");

const worker = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/max-worker.ts"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MAX_BOT_TOKEN: token,
      CORE_BASE_URL: baseUrl,
      MAX_BASE_URL: "http://127.0.0.1:8099",
      ESCALATION_MODE: "on",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const workerLog = [];
worker.stdout.on("data", (chunk) => {
  const line = String(chunk).trim();
  workerLog.push(line);
  console.log(`  [воркер] ${line.slice(0, 160)}`);
});
worker.stderr.on("data", (chunk) => {
  const line = String(chunk).trim();
  workerLog.push(line);
  console.log(`  [воркер] ${line.slice(0, 160)}`);
});

async function setShadowMode(enabled) {
  await pool.query("UPDATE tenants SET shadow_mode = $1 WHERE slug = 'demo-tenant'", [enabled]);
  const result = await pool.query("SELECT shadow_mode FROM tenants WHERE slug = 'demo-tenant'");
  console.log(`  tenants.shadow_mode = ${result.rows[0]?.shadow_mode}`);
}

async function queue() {
  const result = await pool.query(
    `SELECT id, channel, conversation_id, reason, result, trace_ref, status
       FROM escalations
      WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'demo-tenant')
        AND channel = 'max'
      ORDER BY created_at DESC LIMIT 5`,
  );
  return result.rows;
}

try {
  // Живой прогон в тени: `POST /messages` вызываться не должен.
  console.log("ЖИВОЙ ПРОГОН: MAX, режим тени включён");
  await setShadowMode(true);
  sentCalls = 0;
  await sleep(25_000);
  console.log(`  вызовов POST /messages: ${sentCalls}`);
  const shadowQueue = await queue();
  console.log(`  записей очереди с каналом max: ${shadowQueue.length}`);
  for (const row of shadowQueue.slice(0, 1)) {
    console.log(`  channel=${row.channel}, conversation_id=${row.conversation_id}, reason=${row.reason}, trace_ref=${row.trace_ref}, status=${row.status}`);
    console.log(`  result=${String(row.result).slice(0, 110)}`);
  }

  // После отключения следующая обработка может отправить ответ.
  console.log("ЖИВОЙ ПРОГОН: MAX, режим тени выключен");
  await setShadowMode(false);
  sentCalls = 0;
  await sleep(25_000);
  console.log(`  вызовов POST /messages: ${sentCalls}`);
  const finalQueue = await queue();
  console.log(`  записей очереди с каналом max после отключения: ${finalQueue.length}`);
} finally {
  await setShadowMode(false);
  worker.kill("SIGTERM");
  await sleep(1500);
  worker.kill("SIGKILL");
  stub.close();
  await pool.end();
}
