-- Up Migration
CREATE TABLE policy_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  rule_key text NOT NULL,
  threshold numeric(12,4) NULL,
  action text NOT NULL CHECK (action IN ('allow', 'escalate')),
  note text NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz NULL
);

CREATE UNIQUE INDEX policy_rules_tenant_rule_key_valid_from_idx
  ON policy_rules (tenant_id, rule_key, valid_from);

-- Down Migration
DROP TABLE policy_rules;
