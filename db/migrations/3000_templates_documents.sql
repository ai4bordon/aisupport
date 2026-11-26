-- Up Migration
-- Таблицы шаблонов и созданных документов (docs/data-model.md §3.16–3.17).
CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('quote', 'invoice', 'response')),
  name text NOT NULL,
  body text NOT NULL,
  placeholders jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX templates_tenant_kind_name_version_idx
  ON templates (tenant_id, kind, name, version);

CREATE INDEX templates_tenant_kind_is_active_idx
  ON templates (tenant_id, kind, is_active);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  kind text NOT NULL CHECK (kind IN ('quote', 'invoice')),
  number text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  vat integer NOT NULL CHECK (vat >= 0),
  valid_until timestamptz NULL,
  pdf_path text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Номер документа уникален в пределах тенанта (docs/data-model.md §3.17).
CREATE UNIQUE INDEX documents_tenant_kind_number_idx
  ON documents (tenant_id, kind, number);

-- Down Migration
DROP TABLE documents;
DROP TABLE templates;
