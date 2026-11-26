-- Up Migration
-- История снимков товарного фида — docs/data-model.md §3.23.
-- Регламент обновления — раз в сутки, ручной запуск импорта: планировщика нет.
-- Новый снимок не удаляет предыдущий, `is_current` переключается.

CREATE TABLE catalog_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  source_url text NOT NULL,
  feed_date timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  snapshot_hash text NOT NULL,
  offers_count integer NOT NULL DEFAULT 0,
  categories_count integer NOT NULL DEFAULT 0,
  is_current boolean NOT NULL DEFAULT false,
  source_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX catalog_snapshots_tenant_hash_uk
  ON catalog_snapshots (tenant_id, snapshot_hash);
CREATE INDEX catalog_snapshots_tenant_current_idx
  ON catalog_snapshots (tenant_id, is_current);

-- products.snapshot_id ссылается на снимок, из которого взята позиция.
ALTER TABLE products
  ADD CONSTRAINT products_snapshot_id_fkey
  FOREIGN KEY (snapshot_id) REFERENCES catalog_snapshots (id);

-- Down Migration
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_snapshot_id_fkey;
DROP TABLE IF EXISTS catalog_snapshots;
