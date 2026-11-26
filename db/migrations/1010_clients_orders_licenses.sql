-- Up Migration
-- Клиенты, заказы и лицензии — docs/data-model.md §3.10–§3.12.
-- Таблицы заказчика создаются этим же срезом: лицензии ссылаются на products.

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  inn text,
  segment text NOT NULL,
  manager_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clients_tenant_name_idx ON clients (tenant_id, name);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  status text NOT NULL,
  paid_at timestamptz,
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_tenant_client_created_idx
  ON orders (tenant_id, client_id, created_at DESC);

CREATE TABLE licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  keys_total integer NOT NULL DEFAULT 0 CHECK (keys_total >= 0),
  keys_used integer NOT NULL DEFAULT 0 CHECK (keys_used >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX licenses_tenant_client_expires_idx
  ON licenses (tenant_id, client_id, expires_at);

-- Down Migration
DROP TABLE IF EXISTS licenses;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS clients;
