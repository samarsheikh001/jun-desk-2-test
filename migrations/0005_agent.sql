-- M5: support agent as code (AI-18), HTTP tools (AI-05), action audit log (AI-11), eval CLI (AI-19).

-- Every saved agent config is a new version (from the dashboard or `jun push`).
-- The highest version is the live one. files = JSON {"AGENTS.md": "…", "skills/refund/SKILL.md": "…", …}.
CREATE TABLE agent_configs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  files         TEXT NOT NULL,
  message       TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL CHECK (source IN ('dashboard', 'cli')),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, version)
);

-- AI-11: every tool call the AI makes, with what it sent and got back.
CREATE TABLE ai_actions (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_seq      INTEGER NOT NULL,                -- the visitor message being answered
  config_version   INTEGER,                         -- null = built-in default config
  tool             TEXT NOT NULL,
  input            TEXT NOT NULL,                   -- JSON
  output           TEXT,                            -- JSON or text, truncated
  status           TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  http_status      INTEGER,
  duration_ms      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX ai_actions_conversation ON ai_actions (conversation_id, created_at);

-- Personal API tokens for the `jun` CLI (pull/push/eval). Scoped to one workspace; stored hashed.
CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
