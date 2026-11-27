#!/usr/bin/env node
// Живая проверка MAX: ждёт входящее сообщение боту и отвечает в тот же диалог.
//
// Запуск: node scripts/max-live-check.mjs
//
// Токен берётся из переменной окружения MAX_BOT_TOKEN и в вывод не попадает:
// печатаются только коды ответов, типы событий и обрезанные тексты.
const baseUrl = process.env.MAX_BASE_URL ?? "https://platform-api.max.ru";
const token = process.env.MAX_BOT_TOKEN;

if (!token) {
  console.error("MAX_BOT_TOKEN не задан");
  process.exit(2);
}

const waitSeconds = Number(process.env.MAX_WAIT_SECONDS ?? 120);
const answer = process.env.MAX_ANSWER ?? "Агент на связи.";
const authorization = { Authorization: token };

const response = await fetch(`${baseUrl}/updates?timeout=${waitSeconds}&limit=10`, {
  headers: authorization,
});

if (!response.ok) {
  const body = await response.text().catch(() => "");
  console.error(`GET /updates → ${response.status} ${body.slice(0, 300)}`);
  process.exit(1);
}

const payload = await response.json();
const updates = Array.isArray(payload?.updates) ? payload.updates : [];
console.log(`GET /updates → 200, обновлений: ${updates.length}, marker: ${payload?.marker}`);

const incoming = updates.find((update) => update?.update_type === "message_created");
if (!incoming) {
  console.log("Входящих сообщений нет: нужен запрос от пользователя в веб-версии MAX.");
  process.exit(3);
}

const chatId = incoming?.chat_id;
const text = String(incoming?.message?.body?.text ?? "").slice(0, 80);
console.log(`Входящее: тип=${incoming?.update_type}, chat_id=${chatId}, текст="${text}"`);

if (!chatId) {
  console.error("В событии нет chat_id: ответить некуда.");
  process.exit(1);
}

const sendResponse = await fetch(`${baseUrl}/messages`, {
  method: "POST",
  headers: { ...authorization, "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text: answer }),
});

const sent = await sendResponse.json().catch(() => null);
console.log(`POST /messages → ${sendResponse.status}`);
if (sent?.message?.mid) {
  console.log(`Ответ отправлен: mid=${sent.message.mid}, chat_id=${chatId}`);
} else {
  console.log(`Тело ответа: ${JSON.stringify(sent).slice(0, 300)}`);
}

process.exit(sendResponse.ok ? 0 : 1);
