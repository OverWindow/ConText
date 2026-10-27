CREATE SCHEMA IF NOT EXISTS unified;
CREATE TABLE IF NOT EXISTS unified.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS unified.users (
  id uuid PRIMARY KEY, auth_user_id uuid NOT NULL UNIQUE, email text NOT NULL,
  display_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS unified.workspaces (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES unified.users(id),
  metadata jsonb NOT NULL, epoch bigint NOT NULL DEFAULT 1 CHECK(epoch > 0),
  cursor bigint NOT NULL DEFAULT 0 CHECK(cursor >= 0), deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS unified.workspace_members (
  workspace_id uuid NOT NULL REFERENCES unified.workspaces(id),
  user_id uuid NOT NULL REFERENCES unified.users(id), role text NOT NULL CHECK(role IN ('OWNER','EDITOR','VIEWER')),
  PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS unified.entities (
  workspace_id uuid NOT NULL REFERENCES unified.workspaces(id),
  collection text NOT NULL CHECK(collection IN ('entries','documents','versions','canvas_elements','relations','drafts','proposals','chat_sessions','chat_messages','artifacts','conflicts')),
  id uuid NOT NULL, payload jsonb NOT NULL, parent_id uuid, name_key text, deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,collection,id)
);
CREATE INDEX IF NOT EXISTS entities_parent_page ON unified.entities(workspace_id,collection,parent_id,name_key,id);
CREATE INDEX IF NOT EXISTS entities_search ON unified.entities(workspace_id,collection,name_key text_pattern_ops,id) WHERE NOT deleted;
CREATE UNIQUE INDEX IF NOT EXISTS entries_live_sibling_name ON unified.entities(workspace_id,parent_id,name_key)
  WHERE collection='entries' AND NOT deleted AND parent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS unified.device_bindings (
  workspace_id uuid NOT NULL REFERENCES unified.workspaces(id), device_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES unified.users(id), name text NOT NULL, platform text NOT NULL,
  epoch bigint NOT NULL, ack_cursor bigint NOT NULL DEFAULT 0, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,device_id)
);
CREATE TABLE IF NOT EXISTS unified.command_receipts (
  workspace_id uuid NOT NULL REFERENCES unified.workspaces(id), operation_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES unified.users(id), fingerprint text NOT NULL,
  result jsonb NOT NULL, sequence bigint, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS unified.workspace_changes (
  workspace_id uuid NOT NULL REFERENCES unified.workspaces(id), sequence bigint NOT NULL,
  operation_id uuid NOT NULL, epoch bigint NOT NULL, changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,sequence),
  UNIQUE(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS unified.blobs (
  workspace_id uuid NOT NULL REFERENCES unified.workspaces(id), id uuid NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), size bigint NOT NULL CHECK(size >= 0),
  mime_type text NOT NULL, storage_key text NOT NULL UNIQUE,
  uploader_id uuid NOT NULL REFERENCES unified.users(id), verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS blobs_content ON unified.blobs(workspace_id,sha256,size);
CREATE TABLE IF NOT EXISTS unified.processing_jobs (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES unified.workspaces(id),
  requested_by uuid NOT NULL REFERENCES unified.users(id), request_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('parse','convert','ai')), version_id uuid,
  input jsonb NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed')),
  attempts integer NOT NULL DEFAULT 0, lease_until timestamptz, result jsonb, error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,request_id)
);
CREATE INDEX IF NOT EXISTS processing_claim ON unified.processing_jobs(status,lease_until,created_at);
CREATE TABLE IF NOT EXISTS unified.document_texts (
  workspace_id uuid NOT NULL REFERENCES unified.workspaces(id), version_id uuid NOT NULL,
  document_id uuid NOT NULL, artifact_id uuid NOT NULL, processor_fingerprint text NOT NULL,
  body text NOT NULL, search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',body)) STORED,
  PRIMARY KEY(workspace_id,version_id)
);
CREATE INDEX IF NOT EXISTS document_texts_search ON unified.document_texts USING gin(search_vector);
CREATE INDEX IF NOT EXISTS document_texts_workspace ON unified.document_texts(workspace_id,document_id);
INSERT INTO unified.schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
