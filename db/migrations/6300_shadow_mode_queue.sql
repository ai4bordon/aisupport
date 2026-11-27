-- Up Migration
-- Режим тени: очередь менеджера и единая настройка (ADR-0008, R10).
--
-- Запись очереди получает три поля:
-- - `channel` — канал, из которого пришёл результат (`web` или `max`);
-- - `result` — сам результат (черновик или резюме), который менеджер увидит;
-- - `trace_ref` — безопасная ссылка на трассу: идентификатор диалога, по
--   которому трасса ищется в `agent_steps`.
--
-- Канал переносится из `conversations.channel`: диалог — единственное
-- место, где канал известен точно, а не «на глаз» по записи очереди.
--
-- Дублирующее поле `channel_state.shadow_mode` удаляется: единственный
-- источник истины — `tenants.shadow_mode`, иначе веб-чат и MAX показали бы
-- разные значения одной настройки.
ALTER TABLE escalations ADD COLUMN channel text NULL;

UPDATE escalations e
   SET channel = c.channel
  FROM conversations c
 WHERE c.id = e.conversation_id;

-- Строки без канала удаляются: диалог для них обязателен (внешний ключ),
-- поэтому такая строка означает повреждённые данные, а не рабочую запись.
DELETE FROM escalations WHERE channel IS NULL;

ALTER TABLE escalations
  ALTER COLUMN channel SET NOT NULL,
  ADD CONSTRAINT escalations_channel_check CHECK (channel IN ('web', 'max'));

-- Результат — то, что менеджер увидит в очереди. У старых записей его нет:
-- резюме или черновик — то, чем запись была полезна до перехода.
ALTER TABLE escalations ADD COLUMN result text NULL;

UPDATE escalations SET result = COALESCE(draft, summary);

ALTER TABLE escalations ALTER COLUMN result SET NOT NULL;

-- Ссылка на трассу — идентификатор диалога: UUID без секретов и без
-- полного содержимого журнала.
ALTER TABLE escalations ADD COLUMN trace_ref uuid NULL;

UPDATE escalations SET trace_ref = conversation_id;

ALTER TABLE escalations
  ALTER COLUMN trace_ref SET NOT NULL,
  ADD CONSTRAINT escalations_trace_ref_fkey FOREIGN KEY (trace_ref) REFERENCES conversations (id);

CREATE INDEX escalations_tenant_channel_status_created_at_idx
  ON escalations (tenant_id, channel, status, created_at DESC);

-- Настройка режима тени одна: `tenants.shadow_mode`.
ALTER TABLE channel_state DROP COLUMN IF EXISTS shadow_mode;

-- Down Migration
ALTER TABLE channel_state
  ADD COLUMN IF NOT EXISTS shadow_mode boolean NOT NULL DEFAULT false;

DROP INDEX IF EXISTS escalations_tenant_channel_status_created_at_idx;

ALTER TABLE escalations
  DROP CONSTRAINT IF EXISTS escalations_trace_ref_fkey,
  DROP CONSTRAINT IF EXISTS escalations_channel_check;

ALTER TABLE escalations
  DROP COLUMN IF EXISTS trace_ref,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS channel;
