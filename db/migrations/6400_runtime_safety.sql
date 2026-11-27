-- Up Migration
-- Идемпотентный ключ шага трассы (R16, docs/plans/10-runtime-safety.md, шаг 4).
--
-- `step_key` связывает шаг с ключом хода (`message_id`:`node`), а не с
-- порядковым номером: повторная доставка того же хода не должна создавать
-- второй шаг. Уникальный индекс защищает от дублей, но не заменяет
-- сериализацию на уровне диалога (`src/core/dialog-lock.ts`): без блокировки
-- два параллельных хода корректно запишут разные шаги и при этом потеряют
-- обновление состояния.
ALTER TABLE agent_steps ADD COLUMN step_key text NULL;

-- Существующие шаги получают ключ по своему идентификатору: он уникален,
-- поэтому миграция безопасна для имеющихся данных.
UPDATE agent_steps SET step_key = id::text WHERE step_key IS NULL;

ALTER TABLE agent_steps ALTER COLUMN step_key SET NOT NULL;

CREATE UNIQUE INDEX agent_steps_tenant_conversation_step_key_idx
  ON agent_steps (tenant_id, conversation_id, step_key);

-- Down Migration
DROP INDEX IF EXISTS agent_steps_tenant_conversation_step_key_idx;

ALTER TABLE agent_steps DROP COLUMN IF EXISTS step_key;
