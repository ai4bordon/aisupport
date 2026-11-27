-- Up Migration
-- Загрузка документов базы знаний менеджером (тикет 03, R6, ADR-0005).
--
-- Семантика состояний `kb_documents.status`:
-- - `pending` — документ разобран и проиндексирован, ждёт одобрения менеджера;
-- - `published` — одобрен менеджером, доступен поиску;
-- - `rejected` — отклонён менеджером, никогда не индексируется;
-- - `error` — разбор или индексация не удались: материал недоступен поиску,
--   остаётся видимым менеджеру и может быть обработан повторно.
--
-- Результат разбора отделён от статуса публикации: `parse_status` говорит,
-- что получилось с файлом (`not_parsed`/`parsed`/`failed`), а `status` — открыт
-- ли материал поиску. Документ может быть разобран (`parsed`) и при этом ещё
-- не опубликован (`pending`).
--
-- Провенанс загрузки живёт здесь, а не в `kb_sources`: у материала менеджера
-- нет URL источника, а `kb_sources.origin` ограничен значениями
-- `docs_site`/`store_page`.
ALTER TABLE kb_documents
  DROP CONSTRAINT kb_documents_status_check;
ALTER TABLE kb_documents
  ADD CONSTRAINT kb_documents_status_check
  CHECK (status IN ('pending', 'published', 'rejected', 'error'));

-- Результат разбора файла.
ALTER TABLE kb_documents
  ADD COLUMN parse_status text NOT NULL DEFAULT 'not_parsed'
  CHECK (parse_status IN ('not_parsed', 'parsed', 'failed'));

-- Понятное сообщение об ошибке разбора или индексации: без стека и секретов.
ALTER TABLE kb_documents
  ADD COLUMN parse_error text NULL;

-- Провенанс загрузки: кто загрузил, когда, исходное имя файла и MIME-сигнатура.
ALTER TABLE kb_documents
  ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Происхождение материала: поток менеджера отделён от импорта с сайта.
ALTER TABLE kb_documents
  ADD COLUMN source_kind text NOT NULL DEFAULT 'manager_upload'
  CHECK (source_kind IN ('manager_upload'));

-- Ссылка на материал в кабинете менеджера и хеш содержимого: по хешу
-- повторная загрузка того же файла распознаётся, а не плодит дубли.
ALTER TABLE kb_documents
  ADD COLUMN source_url text NULL;
ALTER TABLE kb_documents
  ADD COLUMN snapshot_hash text NULL;

-- Кто и по какой причине решил судьбу документа.
ALTER TABLE kb_documents
  ADD COLUMN approved_by text NULL;
ALTER TABLE kb_documents
  ADD COLUMN rejected_reason text NULL;

-- Хронология попыток: состояние ошибки должно быть восстановимым, а по
-- журналу видно, сколько раз разбор повторяли.
ALTER TABLE kb_documents
  ADD COLUMN parsed_at timestamptz NULL;
ALTER TABLE kb_documents
  ADD COLUMN failed_at timestamptz NULL;
ALTER TABLE kb_documents
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0;
ALTER TABLE kb_documents
  ADD COLUMN last_attempt_at timestamptz NULL;

-- Объём извлечённого текста: по нему видно, что разбор дал содержимое.
ALTER TABLE kb_documents
  ADD COLUMN extracted_chars integer NOT NULL DEFAULT 0;

-- Выборка материалов в разборе и в ошибке.
CREATE INDEX kb_documents_tenant_parse_status_created_at_idx
  ON kb_documents (tenant_id, parse_status, created_at DESC);

-- Down Migration
DROP INDEX IF EXISTS kb_documents_tenant_parse_status_created_at_idx;

ALTER TABLE kb_documents DROP COLUMN IF EXISTS extracted_chars;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS last_attempt_at;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS retry_count;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS failed_at;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS parsed_at;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS rejected_reason;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS approved_by;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS snapshot_hash;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS source_url;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS source_kind;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS provenance;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS parse_error;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS parse_status;

-- Ограничение статуса возвращается к исходному набору: `error` без
-- соответствующих колонок не имеет смысла.
ALTER TABLE kb_documents
  DROP CONSTRAINT kb_documents_status_check;

-- Материал в состоянии ошибки после отката не имеет состояния ошибки:
-- он остаётся в базе, но помечается как отклонённый, чтобы ограничение
-- статуса снова выполнялось. Сами документы и их содержимое не теряются.
UPDATE kb_documents SET status = 'rejected' WHERE status = 'error';

ALTER TABLE kb_documents
  ADD CONSTRAINT kb_documents_status_check
  CHECK (status IN ('pending', 'published', 'rejected'));
