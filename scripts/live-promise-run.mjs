import { randomUUID } from "node:crypto";

/**
 * Живой прогон среза 07 через веб-чат.
 *
 * Отправляет сообщение в стенд и печатает ответ и содержимое журнала
 * обещаний. Реальные персональные данные не используются: адрес клиента —
 * синтетический, в журнале он и остаётся.
 *
 * Запуск: node scripts/live-promise-run.mjs <base-url> <текст> [email]
 */
const baseUrl = process.argv[2] ?? "http://127.0.0.1:3017";
const text = process.argv[3] ?? "Как получить электронную лицензию?";
const email = process.argv[4] ?? null;

const conversationId = randomUUID();

const response = await fetch(`${baseUrl}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    conversation_id: conversationId,
    message: { client_message_id: randomUUID(), text },
  }),
});

const body = await response.json();
console.log("HTTP", response.status);
console.log("conversation_id:", conversationId);
console.log("outcome:", body.outcome);
console.log("answer:", body.answer?.text ?? "(нет ответа)");
console.log("escalation:", body.escalation?.reason ?? "(нет эскалации)");

const journal = await fetch(`${baseUrl}/api/promises`);
const promises = await journal.json();
console.log("журнал обещаний:");
for (const item of promises.promises ?? []) {
  console.log(
    `  ${item.status} | ${item.channel} | ${item.contact ?? "-"} | срок ${item.due_at} | ${item.origin} | ${item.text}`,
  );
}

if (email !== null) {
  console.log("подсказка: адрес для проверки веб-канала —", email);
}
