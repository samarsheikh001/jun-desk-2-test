-- M7 inbox basics: @mentions in internal notes (I-05), saved replies (I-06), tags (I-07).
-- Internal notes themselves are messages with internal = 1 and author_type 'agent'.

-- Who was @mentioned in a note. read_at is set when they open the conversation.
CREATE TABLE mentions (
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  read_at          INTEGER,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX mentions_user ON mentions (user_id, read_at, created_at DESC);

-- Shared canned answers, inserted from the composer with "/".
CREATE TABLE saved_replies (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX saved_replies_workspace ON saved_replies (workspace_id, title);

-- Conversation tags (agents only, never shown to visitors).
CREATE TABLE tags (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL COLLATE NOCASE,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE conversation_tags (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id           TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, tag_id)
);
CREATE INDEX conversation_tags_tag ON conversation_tags (tag_id);
