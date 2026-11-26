-- Up Migration
CREATE TABLE escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  reason text NOT NULL,
  summary text NOT NULL,
  draft text NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  sla_due_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX escalations_tenant_status_created_at_idx
  ON escalations (tenant_id, status, created_at DESC);

CREATE TABLE promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  text text NOT NULL,
  due_at timestamptz NOT NULL,
  owner text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'overdue')),
  reminded_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX promises_tenant_status_due_at_idx
  ON promises (tenant_id, status, due_at);

-- Down Migration
DROP TABLE promises;
DROP TABLE escalations;
