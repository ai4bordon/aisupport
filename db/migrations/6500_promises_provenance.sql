-- Up Migration
-- Провенанс подтверждённого источника и явная пометка синтетической записи
-- (docs/plans/07-promises.md, шаг 1).
--
-- Таблица `promises` создана миграцией 140: колонки `due_at`, `owner` и
-- `status` уже покрывают требования к сроку, ответственному и статусу, поэтому
-- они не дублируются и не переименовываются.
--
-- `source_kind` и `source_id` — откуда взято обязательство: обещание без
-- подтверждённого источника код не создаёт, а по этим колонкам менеджер
-- видит происхождение записи.
--
-- `is_synthetic` — пометка демонстрационной записи: синтетическое обещание
-- нельзя выдать за реальное обязательство клиенту.
ALTER TABLE promises
  ADD COLUMN source_kind text NULL,
  ADD COLUMN source_id text NULL,
  ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;

-- Индекс выборки просроченных: журнал менеджера идёт по сроку, а не по
-- времени создания записи.
CREATE INDEX promises_tenant_due_at_idx
  ON promises (tenant_id, due_at);

-- Down Migration
DROP INDEX IF EXISTS promises_tenant_due_at_idx;
ALTER TABLE promises
  DROP COLUMN IF EXISTS is_synthetic,
  DROP COLUMN IF EXISTS source_id,
  DROP COLUMN IF EXISTS source_kind;
