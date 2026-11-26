-- Up Migration
-- Каталог товарного фида: products, catalog_categories, price_rules.
-- Схема — docs/data-model.md §3.6–§3.9. Вектора у каталога нет: поиск структурный.

CREATE TABLE catalog_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  category_id text NOT NULL,
  parent_id text,
  name text NOT NULL,
  path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX catalog_categories_tenant_category_uk
  ON catalog_categories (tenant_id, category_id);
CREATE INDEX catalog_categories_tenant_parent_idx
  ON catalog_categories (tenant_id, parent_id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  offer_id text NOT NULL,
  group_id text,
  name text NOT NULL,
  vendor text,
  vendor_url text,
  product_url text,
  price numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  old_price numeric(14,2),
  currency_id text NOT NULL DEFAULT 'RUR',
  category_id text,
  available boolean NOT NULL DEFAULT false,
  delivery boolean,
  pickup boolean,
  description text,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'approved_by_customer',
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX products_tenant_offer_uk
  ON products (tenant_id, offer_id);
CREATE INDEX products_tenant_published_available_idx
  ON products (tenant_id, published, available);
CREATE INDEX products_name_fts_idx
  ON products USING GIN (to_tsvector('russian', name));
CREATE INDEX products_tenant_group_idx
  ON products (tenant_id, group_id);
CREATE INDEX products_tenant_category_idx
  ON products (tenant_id, category_id);
CREATE INDEX products_tenant_vendor_idx
  ON products (tenant_id, vendor);
CREATE INDEX products_tenant_snapshot_idx
  ON products (tenant_id, snapshot_id);

CREATE TABLE price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  segment text NOT NULL,
  min_qty integer NOT NULL DEFAULT 1,
  discount_max numeric(5,2) NOT NULL CHECK (discount_max >= 0 AND discount_max <= 100),
  postpay_allowed boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX price_rules_tenant_product_segment_idx
  ON price_rules (tenant_id, product_id, segment, valid_from);

-- Down Migration
DROP TABLE IF EXISTS price_rules;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS catalog_categories;
