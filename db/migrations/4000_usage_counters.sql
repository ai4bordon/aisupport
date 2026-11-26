-- Up Migration
-- Серверные счётчики защиты публичного стенда (docs/data-model.md §3.20).
-- Счётчики живут в базе, а не в памяти процесса: перезапуск не обнуляет
-- суточный счётчик диалогов.
CREATE TABLE usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL,
  bucket_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  spend_rub numeric(12,4) NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_counters_scope_check
    CHECK (scope IN ('requests_minute', 'dialogs_daily', 'model_budget_hour', 'model_budget_day')),
  CONSTRAINT usage_counters_counter_check CHECK (counter >= 0),
  CONSTRAINT usage_counters_spend_check CHECK (spend_rub >= 0)
);

CREATE UNIQUE INDEX usage_counters_unique
  ON usage_counters (tenant_id, scope, bucket_key, window_start);

CREATE INDEX usage_counters_window
  ON usage_counters (tenant_id, scope, window_start DESC);

-- Down Migration
DROP TABLE usage_counters;
