-- A-02: one topic label per conversation (agents only, never shown to visitors). The AI labels
-- conversations in batches once they're resolved or quiet (worker/ai/topics.ts), reusing the
-- workspace's existing topics; admins rename, merge and delete them in Settings.
CREATE TABLE topics (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL COLLATE NOCASE,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

ALTER TABLE conversations ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL;
-- When the AI last looked at it (with or without a result). NULL = never: the job's to-do list.
ALTER TABLE conversations ADD COLUMN topic_labeled_at INTEGER;
CREATE INDEX conversations_topic ON conversations (workspace_id, topic_id);
