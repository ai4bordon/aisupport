-- Up Migration
-- Провенанс подтверждённого источника, пометка синтетической записи,
-- канал доставки и адресат (docs/plans/07-promises.md, шаги 1 и 5).
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
--
-- `channel` — канал доставки: `max` (адресат — диалог) или `email`
-- (адресат — адрес клиента).
--
-- `contact_email` — восстановленное значение адреса для кабинета менеджера,
-- `contact_label` — метка, под которой адрес ушёл в модель и трассу.
-- `external_chat_id` — диалог MAX, он же адресат в этом канале.
ALTER TABLE promises
  ADD COLUMN source_kind text NULL,
  ADD COLUMN source_id text NULL,
  ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false,
  ADD COLUMN channel text NOT NULL DEFAULT 'max',
  ADD COLUMN contact_email text NULL,
  ADD COLUMN contact_label text NULL,
  ADD COLUMN external_chat_id text NULL;

ALTER TABLE promises
  ADD CONSTRAINT promises_channel_check CHECK (channel IN ('max', 'email'));

-- Индекс выборки просроченных: журнал менеджера идёт по сроку, а не по
-- времени создания записи.
CREATE INDEX promises_tenant_due_at_idx
  ON promises (tenant_id, due_at);

-- Down Migration
DROP INDEX IF EXISTS promises_tenant_due_at_idx;
ALTER TABLE promises DROP CONSTRAINT IF EXISTS promises_channel_check;
ALTER TABLE promises
  DROP COLUMN IF EXISTS external_chat_id,
  DROP COLUMN IF EXISTS contact_label,
  DROP COLUMN IF EXISTS contact_email,
  DROP COLUMN IF EXISTS channel,
  DROP COLUMN IF EXISTS is_synthetic,
  DROP COLUMN IF EXISTS source_id,
  DROP COLUMN IF EXISTS source_kind;
