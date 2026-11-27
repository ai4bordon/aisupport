-- Up Migration
-- Источники базы знаний заказчика: сайт docs.softline.com и страница
-- store.softline.ru/delivery_info/ (docs/data-model.md §3.22).
--
-- Источник, импортированный с сайта заказчика, получает статус
-- approved_by_customer с непустым провенансом и не проходит менеджерское
-- одобрение. Материал менеджера и черновики статей этот поток не задевают.

CREATE TABLE IF NOT EXISTS kb_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  origin text NOT NULL,
  source_url text NOT NULL,
  title text NOT NULL,
  section_path text,
  content_text text NOT NULL,
  raw_html_path text,
  crawled_at timestamptz NOT NULL,
  snapshot_hash text,
  status text NOT NULL,
  provenance text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_sources_origin_check CHECK (origin IN ('docs_site', 'store_page')),
  CONSTRAINT kb_sources_status_check CHECK (
    status IN ('approved_by_customer', 'published', 'pending', 'draft', 'rejected')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS kb_sources_tenant_source_url_idx
  ON kb_sources (tenant_id, source_url);
CREATE INDEX IF NOT EXISTS kb_sources_tenant_origin_status_idx
  ON kb_sources (tenant_id, origin, status);

-- История снимков импортированных источников (docs/data-model.md §3.24).
-- Новый снимок не уничтожает предыдущий: по записям видно, каким источником
-- и когда он получен.
CREATE TABLE IF NOT EXISTS kb_source_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  snapshot_hash text NOT NULL,
  provenance text NOT NULL,
  crawled_at timestamptz NOT NULL,
  status text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  CONSTRAINT kb_source_snapshots_valid_range_check CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS kb_source_snapshots_tenant_source_hash_idx
  ON kb_source_snapshots (tenant_id, source_id, snapshot_hash);
CREATE INDEX IF NOT EXISTS kb_source_snapshots_tenant_source_valid_from_idx
  ON kb_source_snapshots (tenant_id, source_id, valid_from DESC);

-- Down Migration
DROP TABLE IF EXISTS kb_source_snapshots;
DROP TABLE IF EXISTS kb_sources;
