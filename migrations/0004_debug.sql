-- M4: debug context from the visitor's browser (S-01, S-03, S-05, S-07).

-- One snapshot per visitor message that carried context: page, environment and the
-- loader's recent events (errors, failed requests, navigation). Already redacted twice
-- (in the browser and on the server); no request/response bodies are ever captured.
CREATE TABLE debug_snapshots (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL,
  message_seq      INTEGER NOT NULL,
  context          TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX debug_snapshots_conversation ON debug_snapshots(conversation_id, created_at DESC);

-- Errors + failed requests in the latest snapshot, for the inbox badge.
ALTER TABLE conversations ADD COLUMN debug_issue_count INTEGER NOT NULL DEFAULT 0;
