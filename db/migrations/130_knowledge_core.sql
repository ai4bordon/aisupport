-- Up Migration
CREATE TABLE kb_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  storage_path text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'published', 'rejected')),
  chunks_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz NULL
);

CREATE INDEX kb_documents_tenant_status_created_at_idx
  ON kb_documents (tenant_id, status, created_at DESC);

CREATE TABLE kb_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  title text NOT NULL,
  body_md text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'rejected')),
  version integer NOT NULL DEFAULT 1,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz NULL,
  owner text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz NULL
);

CREATE INDEX kb_articles_tenant_status_valid_idx
  ON kb_articles (tenant_id, status, valid_from, valid_to);

CREATE TABLE kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  document_id uuid NULL REFERENCES kb_documents (id),
  article_id uuid NULL REFERENCES kb_articles (id),
  chunk_no integer NOT NULL CHECK (chunk_no >= 0),
  page_no integer NULL CHECK (page_no >= 1),
  text text NOT NULL,
  search_vector tsvector NOT NULL,
  embedding vector (1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Чанк принадлежит либо документу, либо статье — но не обоим и ни одному.
  CONSTRAINT kb_chunks_owner_xor CHECK (num_nonnulls (document_id, article_id) = 1)
);

CREATE UNIQUE INDEX kb_chunks_tenant_document_chunk_no_idx
  ON kb_chunks (tenant_id, document_id, chunk_no)
  WHERE document_id IS NOT NULL;

CREATE UNIQUE INDEX kb_chunks_tenant_article_chunk_no_idx
  ON kb_chunks (tenant_id, article_id, chunk_no)
  WHERE article_id IS NOT NULL;

CREATE INDEX kb_chunks_embedding_idx
  ON kb_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX kb_chunks_search_vector_idx
  ON kb_chunks USING gin (search_vector);

CREATE TABLE agent_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  node text NOT NULL,
  endpoint text NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_rub numeric(12,4) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome text NULL CHECK (outcome IN ('respond', 'escalate')),
  model text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_steps_tenant_conversation_created_at_idx
  ON agent_steps (tenant_id, conversation_id, created_at);

-- Down Migration
DROP TABLE agent_steps;
DROP TABLE kb_chunks;
DROP TABLE kb_articles;
DROP TABLE kb_documents;
