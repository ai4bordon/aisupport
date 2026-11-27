-- Up Migration
-- Черновик статьи из материалов диалога: состояния проверки и провенанс
-- (тикет 04, ADR-0005).
--
-- `kb_articles` создана миграцией 130: своя таблица не нужна и заводить её
-- нельзя, потому что чанк статьи и чанк документа живут в одной таблице
-- `kb_chunks` с ограничением «ровно один владелец». Миграция расширяет
-- существующую сущность полями провенанса и недостающими состояниями.
--
-- Семантика состояний:
-- - `pending_review` — материал собран из диалога и ждёт решения менеджера;
--   в поиск не попадает и никогда не индексируется;
-- - `approved` — менеджер одобрил материал, но публикация ещё не выполнена;
--   в поиск не попадает;
-- - `published` — статья опубликована и доступна поиску базы знаний;
-- - `rejected` — решение принято, материал не используется и не индексируется;
-- - `draft` — служебное состояние, потоком тикета не используется.
--
-- Провенанс статьи обязателен: у опубликованной статьи должен быть
-- прослеживаемый исходный диалог и конкретные сообщения, из которых она
-- собрана. Ссылка на источник в поиске — это диалог, а не выдуманный URL:
-- исходного адреса у материала менеджера нет, и подменять его нечем.
ALTER TABLE kb_articles
  DROP CONSTRAINT IF EXISTS kb_articles_status_check;

ALTER TABLE kb_articles
  ADD CONSTRAINT kb_articles_status_check
  CHECK (status IN ('draft', 'pending_review', 'approved', 'published', 'rejected'));

-- Исходный диалог, из которого собран материал статьи.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS conversation_id uuid NULL REFERENCES conversations (id);

-- Идентификаторы сообщений диалога, вошедших в материал.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS source_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Выдержка из исходного материала: что именно менеджер взял в статью.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS source_excerpt text NULL;

-- Менеджер, принявший решение по материалу (одобрил или отклонил).
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS approved_by text NULL;

-- Время решения менеджера по материалу.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL;

-- Время публикации: с этого момента статья доступна поиску.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS published_at timestamptz NULL;

-- Очередь проверки: материалы одного арендатора в порядке поступления.
CREATE INDEX IF NOT EXISTS kb_articles_tenant_review_status_idx
  ON kb_articles (tenant_id, status, created_at DESC);

-- Down Migration
DROP INDEX IF EXISTS kb_articles_tenant_review_status_idx;

ALTER TABLE kb_articles
  DROP COLUMN IF EXISTS published_at,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS source_excerpt,
  DROP COLUMN IF EXISTS source_message_ids,
  DROP COLUMN IF EXISTS conversation_id;

ALTER TABLE kb_articles
  DROP CONSTRAINT IF EXISTS kb_articles_status_check;

ALTER TABLE kb_articles
  ADD CONSTRAINT kb_articles_status_check
  CHECK (status IN ('draft', 'published', 'rejected'));
