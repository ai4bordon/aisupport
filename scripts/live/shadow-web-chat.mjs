#!/usr/bin/env node
// Живой прогон режима тени в веб-чате: проверяется, что клиент ответа не
// получает, а в очереди менеджера появляется запись с каналом, диалогом,
// причиной, результатом и безопасной ссылкой на трассу.
//
// Запуск: DATABASE_URL=... node scripts/live/shadow-web-chat.mjs
import { randomUUID } from "node:crypto";
import pg from "pg";

const baseUrl = process.env.SHADOW_BASE_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL не задан");
  process.exit(2);
}

const pool = new pg.Client({ connectionString: databaseUrl });
await pool.connect();

async function tenantId() {
  const result = await pool.query("SELECT id, shadow_mode FROM tenants WHERE slug = 'demo-tenant'");
  return String(result.rows[0]?.id ?? "");
}

async function setShadowMode(enabled) {
  await pool.query("UPDATE tenants SET shadow_mode = $1 WHERE slug = 'demo-tenant'", [enabled]);
  const result = await pool.query("SELECT shadow_mode FROM tenants WHERE slug = 'demo-tenant'");
  console.log(`  tenants.shadow_mode = ${result.rows[0]?.shadow_mode}`);
}

async function queueFor(id) {
  const result = await pool.query(
    `SELECT id, channel, conversation_id, reason, result, draft, trace_ref, status
       FROM escalations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [id],
  );
  return result.rows;
}

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

const id = await tenantId();
const question = "Как получить электронную лицензию?";

console.log("ЖИВОЙ ПРОГОН: веб-чат, режим тени включён");
await setShadowMode(true);
const shadowConversation = randomUUID();
const shadowResult = await chat(shadowConversation, randomUUID(), question);
console.log(`  HTTP ${shadowResult.status}, outcome=${shadowResult.body.outcome}, answer=${JSON.stringify(shadowResult.body.answer)}`);
console.log(`  escalation.reason=${shadowResult.body.escalation?.reason}, draft=${String(shadowResult.body.escalation?.draft ?? "").slice(0, 90)}`);

const shadowQueue = await queueFor(id);
console.log(`  записей очереди: ${shadowQueue.length}`);
for (const row of shadowQueue.slice(0, 1)) {
  console.log(`  channel=${row.channel}, conversation_id=${row.conversation_id}, reason=${row.reason}, trace_ref=${row.trace_ref}, status=${row.status}`);
  console.log(`  result=${String(row.result).slice(0, 110)}`);
}

const agentMessages = await pool.query(
  "SELECT count(*)::text AS count FROM messages WHERE tenant_id = $1 AND role = 'agent'",
  [id],
);
console.log(`  сообщений агента в переписке: ${agentMessages.rows[0]?.count}`);

console.log("ЖИВОЙ ПРОГОН: веб-чат, режим тени выключен");
await setShadowMode(false);
const openConversation = randomUUID();
const openResult = await chat(openConversation, randomUUID(), question);
console.log(`  HTTP ${openResult.status}, outcome=${openResult.body.outcome}, answer=${String(openResult.body.answer?.text ?? "").slice(0, 90)}`);

const finalQueue = await queueFor(id);
console.log(`  записей очереди после отключения: ${finalQueue.length} (прежняя запись осталась: ${finalQueue.some((row) => row.conversation_id === shadowConversation)})`);

await setShadowMode(false);
await pool.end();
