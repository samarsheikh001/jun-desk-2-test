-- S-08: issues filed from a conversation by an agent (never by the AI on its own), in
-- GitHub or Linear. Where they go is a workspace setting; the credentials are only ever the
-- Worker secrets GITHUB_TOKEN and LINEAR_API_KEY, never stored here.
ALTER TABLE workspaces ADD COLUMN github_repo TEXT;        -- "owner/name"
ALTER TABLE workspaces ADD COLUMN linear_team_id TEXT;     -- Linear team UUID
ALTER TABLE workspaces ADD COLUMN linear_team_key TEXT;    -- e.g. "ENG"
ALTER TABLE workspaces ADD COLUMN linear_team_name TEXT;

CREATE TABLE conversation_issues (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  -- GitHub repo "owner/name", or the Linear team key.
  target           TEXT NOT NULL,
  -- The provider's id (Linear issue id; GitHub issue number as text) and the display key
  -- ("owner/name#123", "ENG-42"). NULL while the request is in flight.
  external_id      TEXT,
  key              TEXT,
  url              TEXT,
  title            TEXT NOT NULL,
  -- The dashboard's idempotency key: one issue per click, even if the request is retried.
  client_id        TEXT NOT NULL,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE (conversation_id, client_id)
);
CREATE INDEX conversation_issues_conversation ON conversation_issues (conversation_id, created_at);
