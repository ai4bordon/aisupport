-- Up Migration
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  channel text NOT NULL CHECK (channel IN ('web', 'max')),
  external_chat_id text NULL,
  client_ref text NULL,
  cookie_digest text NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalate', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX conversations_tenant_channel_external_chat_id_idx
  ON conversations (tenant_id, channel, external_chat_id)
  WHERE external_chat_id IS NOT NULL;

CREATE INDEX conversations_tenant_status_updated_at_idx
  ON conversations (tenant_id, status, updated_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  client_message_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('client', 'agent', 'manager', 'system')),
  text_masked text NOT NULL,
  text_original text NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Идемпотентность повторной отправки: (tenant_id, client_message_id) уникален.
CREATE UNIQUE INDEX messages_tenant_client_message_id_idx
  ON messages (tenant_id, client_message_id);

CREATE INDEX messages_tenant_conversation_created_at_idx
  ON messages (tenant_id, conversation_id, created_at);

-- Down Migration
DROP TABLE messages;
DROP TABLE conversations;
