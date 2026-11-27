-- Up Migration
-- Связь ответа агента с исходным сообщением клиента (находка B1
-- BUGSAUDIT-2026-11-27).
--
-- Идемпотентность повторной отправки должна возвращать ответ именно того
-- сообщения, которое клиент повторил, а не последний ответ диалога. Связи
-- «реплика клиента → ответ агента» в схеме не было: повтор искал последнее
-- сообщение агента в диалоге и возвращал его.
--
-- Новая колонка `reply_to_client_message_id` указывает, на какое сообщение
-- клиента отвечает строка. Для роли `client` она пуста: клиент ни на что не
-- отвечает. Для роли `agent` и `system` — идентификатор исходного сообщения
-- клиента.
--
-- Ссылка ведёт на сообщение того же диалога: иначе ответ диалога можно
-- было бы привязать к чужому сообщению.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_client_message_id uuid NULL;

-- Ссылка на исходное сообщение клиента: ответ агента и его ход.
CREATE INDEX IF NOT EXISTS messages_tenant_conversation_reply_idx
  ON messages (tenant_id, conversation_id, reply_to_client_message_id);

-- Down Migration
DROP INDEX IF EXISTS messages_tenant_conversation_reply_idx;

ALTER TABLE messages DROP COLUMN IF EXISTS reply_to_client_message_id;
