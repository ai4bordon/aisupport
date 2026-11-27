import { randomUUID } from "node:crypto";

/**
 * Живой прогон среза 07 через канал MAX.
 *
 * В MAX адресат — диалог, адрес клиента не нужен (ADR-0018).
 *
 * Запуск: node scripts/live-promise-max.mjs <base-url> <текст> [chat-id]
 */
const baseUrl = process.argv[2] ?? "http://127.0.0.1:3017";
const text = process.argv[3] ?? "Когда будет готово?";
const chatId = process.argv[4] ?? `chat-${randomUUID().slice(0, 8)}`;

const conversationId = randomUUID();

const response = await fetch(`${baseUrl}/api/agent/run`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    conversation_id: conversationId,
    message_id: randomUUID(),
    channel: "max",
    external_chat_id: chatId,
    text,
    masked_fields_count: 0,
  }),
});

const body = await response.json();
console.log("HTTP", response.status);
console.log("conversation_id:", conversationId);
console.log("external_chat_id:", chatId);
console.log("outcome:", body.outcome);
console.log("answer:", body.answer?.text ?? "(нет ответа)");
console.log("escalation:", body.escalation?.reason ?? "(нет эскалации)");

const journal = await fetch(`${baseUrl}/api/promises`);
const promises = await journal.json();
console.log("журнал обещаний:");
for (const item of promises.promises ?? []) {
  console.log(
    `  ${item.status} | ${item.channel} | адресат ${item.contact ?? "-"} | срок ${item.due_at} | ${item.origin} | ${item.text}`,
  );
}
