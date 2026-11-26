-- Up Migration
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  actor text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  before jsonb NULL,
  after jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_entity_created_at_idx
  ON audit_log (tenant_id, entity, created_at DESC);

-- Down Migration
DROP TABLE audit_log;
