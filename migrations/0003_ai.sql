-- M2: AI agent, knowledge base, usage caps.

-- Who is answering: the AI, or a human after handoff/takeover.
ALTER TABLE conversations ADD COLUMN handling TEXT NOT NULL DEFAULT 'human' CHECK (handling IN ('ai', 'human'));

-- Internal messages (handoff briefs, takeover notes) are shown to agents only.
-- meta holds e.g. the sources an AI answer cites: {"sources":[{"title":"…","url":"…"}]}.
ALTER TABLE messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';

CREATE TABLE ai_settings (
  workspace_id        TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 0,
  provider            TEXT NOT NULL DEFAULT 'workers-ai' CHECK (provider IN ('openai', 'workers-ai', 'chatgpt')),
  model               TEXT,                         -- null = provider default
  instructions        TEXT NOT NULL DEFAULT '',     -- persona / tone / guidance (AI-07)
  monthly_reply_cap   INTEGER NOT NULL DEFAULT 2000, -- B-03
  updated_at          INTEGER NOT NULL
);

CREATE TABLE ai_usage (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,                   -- 'YYYY-MM'
  replies         INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, month)
);

-- Dev-only "Sign in with ChatGPT" (D-10): credentials and pending sign-ins.
CREATE TABLE dev_chatgpt (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  credentials   TEXT NOT NULL                       -- JSON ChatGPTCredentials
);
CREATE TABLE dev_chatgpt_states (
  state           TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_verifier   TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  return_to       TEXT NOT NULL,
  expires_at      INTEGER NOT NULL
);

-- Knowledge base (K-01, K-03).
CREATE TABLE kb_sources (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('website', 'snippet')),
  url             TEXT,                             -- website start URL
  title           TEXT NOT NULL,
  body            TEXT,                             -- snippet text
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'ready', 'error')),
  pending_jobs    INTEGER NOT NULL DEFAULT 0,
  page_count      INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  settings        TEXT NOT NULL DEFAULT '{}',       -- JSON: maxPages, robots rules
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX kb_sources_workspace ON kb_sources(workspace_id);

CREATE TABLE kb_documents (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  title           TEXT,
  content_hash    TEXT,
  sync_token      TEXT,                             -- which crawl last claimed this URL
  updated_at      INTEGER NOT NULL,
  UNIQUE (source_id, url)
);

CREATE TABLE kb_chunks (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  workspace_id  TEXT NOT NULL,
  source_id     TEXT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  document_id   TEXT REFERENCES kb_documents(id) ON DELETE CASCADE,
  url           TEXT,
  title         TEXT NOT NULL,
  heading       TEXT NOT NULL DEFAULT '',
  text          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX kb_chunks_document ON kb_chunks(document_id);
CREATE INDEX kb_chunks_source ON kb_chunks(source_id);

-- Keyword search over chunks (hybrid with vector search in the KnowledgeIndex DO).
CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(title, heading, text, content='kb_chunks', content_rowid='rowid');
CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, title, heading, text) VALUES (new.rowid, new.title, new.heading, new.text);
END;
CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, heading, text) VALUES ('delete', old.rowid, old.title, old.heading, old.text);
END;
