-- Up Migration
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  shadow_mode boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Синтетический демо-тенант: допущение, подтверждённых данных заказчика нет.
INSERT INTO tenants (slug, name, shadow_mode)
VALUES ('demo-tenant', 'Демо-тенант', false)
ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DROP TABLE tenants;
