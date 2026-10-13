-- M6: identity verification (V-03), merging visitors into contacts (V-04), custom
-- attributes (V-05), live visitors and agent-started chats (V-01, V-07).

-- Contacts identified by the host app's signed JWT (`sub` claim). Anonymous visitors have none.
ALTER TABLE contacts ADD COLUMN external_id TEXT;
ALTER TABLE contacts ADD COLUMN verified_at INTEGER;
CREATE UNIQUE INDEX contacts_external ON contacts (workspace_id, external_id) WHERE external_id IS NOT NULL;

-- A contact can have several browsers (one token each); an identified user on two devices
-- is one contact. Replaces contacts.visitor_token_hash (kept, no longer written).
CREATE TABLE visitor_tokens (
  token_hash  TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX visitor_tokens_contact ON visitor_tokens (contact_id);
INSERT INTO visitor_tokens (token_hash, contact_id, created_at)
SELECT visitor_token_hash, id, created_at FROM contacts WHERE visitor_token_hash IS NOT NULL;

-- HS256 key the host app signs identity JWTs with. Shown to admins; rotating it revokes all tokens.
ALTER TABLE inboxes ADD COLUMN identity_secret TEXT;

-- V-07: an agent's opening message to a live visitor. Becomes the first message of the
-- conversation if the visitor replies.
CREATE TABLE visitor_invites (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
