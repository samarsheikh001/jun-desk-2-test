-- W-12: CSAT. The widget asks "How did we do?" when a conversation is resolved. A visitor
-- rates once per resolution: writing again reopens the conversation, and when it's resolved
-- again they can rate again. Every rating is kept (A-01 metrics); the conversation row holds
-- the latest one so inbox lists can show and filter it without a join.

-- How many times the conversation has been resolved (counted when the status becomes
-- 'resolved'). A rating belongs to one of these rounds.
ALTER TABLE conversations ADD COLUMN resolution INTEGER NOT NULL DEFAULT 0;
UPDATE conversations SET resolution = 1 WHERE status = 'resolved';
-- The latest rating, and the round it was given in (= resolution means "rated this time").
ALTER TABLE conversations ADD COLUMN csat_rating TEXT CHECK (csat_rating IN ('good', 'bad'));
ALTER TABLE conversations ADD COLUMN csat_at INTEGER;
ALTER TABLE conversations ADD COLUMN csat_resolution INTEGER;
CREATE INDEX conversations_csat ON conversations (workspace_id, csat_rating, last_message_at DESC);

CREATE TABLE csat_ratings (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id       TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  resolution       INTEGER NOT NULL,
  rating           TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
  comment          TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (conversation_id, resolution)
);
CREATE INDEX csat_ratings_workspace ON csat_ratings (workspace_id, created_at);
