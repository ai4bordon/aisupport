import { randomUUID } from "node:crypto";

/**
 * Живой прогон среза 07: переход в просрочку и отметка «отправил».
 *
 * Создаёт синтетическую запись с истёкшим сроком, читает журнал (запись
 * должна попасть в группу overdue) и отмечает выполненной.
 *
 * Запуск: node scripts/live-promise-overdue.mjs <base-url>
 */
import pg from "pg";
const baseUrl = process.argv[2] ?? "http://127.0.0.1:3017";
const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://postgres:postgres@127.0.0.1:5433/support_agent_07";

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const tenant = await client.query(
  "SELECT id FROM tenants WHERE slug = $1",
  [process.env["TENANT_SLUG"] ?? "demo-tenant"],
);
const tenantId = tenant.rows[0]?.id;

const conversation = await client.query(
  `INSERT INTO conversations (tenant_id, channel, status)
   VALUES ($1, 'web', 'open') RETURNING id`,
  [tenantId],
);
const conversationId = conversation.rows[0]?.id ?? "";

await client.query(
  `INSERT INTO promises
     (tenant_id, conversation_id, text, due_at, owner, status, is_synthetic, channel)
   VALUES ($1, $2, 'Синтетическая запись: КП обещан на 01.01.2026',
           now() - interval '1 day', 'manager', 'open', true, 'max')`,
  [tenantId, conversationId],
);

const journal = await fetch(`${baseUrl}/api/promises`);
const promises = await journal.json();
console.log("журнал после чтения (просрочка пересчитывается кодом):");
for (const item of promises.promises ?? []) {
  console.log(
    `  ${item.status} | overdue=${item.overdue} | ${item.channel} | ${item.origin} | срок ${item.due_at} | ${item.text}`,
  );
}

const overdue = (promises.promises ?? []).find(
  (item) => item.origin === "синтетический/демонстрационный",
);
if (overdue) {
  const done = await fetch(`${baseUrl}/api/promises/${overdue.id}/done`, {
    method: "POST",
  });
  console.log("отметка «отправил»: HTTP", done.status, await done.text());
}

const stored = await client.query(
  "SELECT status, reminded_at FROM promises WHERE id = $1",
  [overdue?.id ?? ""],
);
console.log("в базе после отметки:", JSON.stringify(stored.rows[0]));

await client.end();
