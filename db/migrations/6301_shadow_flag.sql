-- Up Migration
-- Признак теневой записи в очереди менеджера (ADR-0008, R10).
--
-- Отдельное поле, а не значение причины: причина исходной эскалации нужна
-- менеджеру сама по себе, а признак тени отвечает на другой вопрос — «это
-- черновик из режима тени или обычная эскалация». На демо менеджер видит это
-- прямо в очереди.
ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS is_shadow boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE escalations DROP COLUMN IF EXISTS is_shadow;
