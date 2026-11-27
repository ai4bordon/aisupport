-- Up Migration
-- Настройки агента: версионируемая конфигурация, привязка версии к диалогу
-- и история тестовых сессий (docs/plans/08-agent-settings-sandbox.md).
--
-- В `agent_settings` лежат только настройки с работающим потребителем:
-- `provider`/`model`/`endpoint`/`temperature`/`max_tokens` читает клиент
-- модели, `system_prompt` — ядро. Полей под нереализованные настройки
-- (`tools`, `skills`, `mcp`, `limits`) здесь нет намеренно: хранить значение
-- без потребителя — значило бы создать видимость настройки, которой нет.
--
-- Колонки `shadow_mode` здесь тоже нет: режим тени живёт в `tenants.shadow_mode`
-- (миграция 110) и тикет 06 объявляет его единственным источником истины.
CREATE TABLE agent_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  version integer NOT NULL CHECK (version >= 1),
  provider text NOT NULL,
  model text NOT NULL,
  endpoint text NOT NULL,
  system_prompt text NOT NULL,
  temperature numeric(4,3) NOT NULL CHECK (temperature >= 0 AND temperature <= 2),
  max_tokens integer NOT NULL CHECK (max_tokens > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Уникальность версии внутри арендатора: две версии одного арендатора не
-- конфликтуют, а одна и та же версия не может быть записана дважды.
CREATE UNIQUE INDEX agent_settings_tenant_version_idx
  ON agent_settings (tenant_id, version);

CREATE INDEX agent_settings_tenant_created_at_idx
  ON agent_settings (tenant_id, created_at DESC);

-- Привязка версии конфигурации к диалогу: изменение настройки действует на
-- следующий новый диалог, а уже открытый диалог продолжает работать на той
-- версии, с которой начался.
CREATE TABLE agent_dialog_settings (
  conversation_id uuid PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_dialog_settings_tenant_version_idx
  ON agent_dialog_settings (tenant_id, version);

-- История тестовых сессий песочницы: конфигурация, результат, оценка,
-- токены и затраты. Секретов и сырых персональных данных здесь нет.
CREATE TABLE agent_test_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  settings_version integer NOT NULL CHECK (settings_version >= 1),
  settings_snapshot jsonb NOT NULL,
  request_text_masked text NOT NULL,
  result jsonb NOT NULL,
  tokens_in integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost_rub numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_rub >= 0),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_test_sessions_tenant_created_at_idx
  ON agent_test_sessions (tenant_id, created_at DESC);

-- Down Migration
DROP TABLE agent_test_sessions;
DROP TABLE agent_dialog_settings;
DROP TABLE agent_settings;
