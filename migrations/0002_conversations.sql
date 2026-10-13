-- M1: inboxes (widget channel), contacts, conversations, messages.
-- D1 is the source of truth; each conversation's Durable Object writes through to it (D-11).

-- A channel into a workspace. M1 has one web-widget inbox per workspace; its public
-- widget_key goes in the embed snippet.
CREATE TABLE inboxes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'widget' CHECK (channel IN ('widget')),
  widget_key    TEXT NOT NULL UNIQUE,
  settings      TEXT NOT NULL DEFAULT '{}',   -- JSON: greeting, colours (W-04)
  created_at    INTEGER NOT NULL
);
CREATE INDEX inboxes_workspace ON inboxes(workspace_id);

-- Every existing workspace gets a default widget inbox.
INSERT INTO inboxes (id, workspace_id, name, widget_key, created_at)
SELECT 'inb_' || lower(hex(randomblob(9))), id, 'Website', 'wk_' || lower(hex(randomblob(12))), created_at FROM workspaces;

-- People who talk to the workspace. Anonymous widget visitors are contacts too; their
-- browser holds a random token, stored here only as a hash.
CREATE TABLE contacts (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                TEXT,
  email               TEXT COLLATE NOCASE,
  visitor_token_hash  TEXT UNIQUE,
  attributes          TEXT NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL
);
CREATE INDEX contacts_workspace ON contacts(workspace_id);

-- One table for chats and tickets (D-05).
CREATE TABLE conversations (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inbox_id              TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  contact_id            TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'ticket')),
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'snoozed', 'resolved')),
  assignee_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_seq              INTEGER NOT NULL DEFAULT 0,
  last_message_at       INTEGER NOT NULL,
  last_message_preview  TEXT,
  last_message_author   TEXT,
  agent_read_seq        INTEGER NOT NULL DEFAULT 0,   -- highest seq any agent has read
  visitor_read_seq      INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX conversations_inbox_list ON conversations(workspace_id, status, last_message_at DESC);
CREATE INDEX conversations_contact ON conversations(contact_id, last_message_at DESC);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,             -- per-conversation order, assigned by the Durable Object
  author_type      TEXT NOT NULL CHECK (author_type IN ('visitor', 'agent', 'ai', 'system')),
  author_id        TEXT,                         -- user id for agents, contact id for visitors
  body             TEXT NOT NULL DEFAULT '',
  attachments      TEXT NOT NULL DEFAULT '[]',   -- JSON [{ key, name, size, type }]
  client_msg_id    TEXT NOT NULL,                -- idempotency key from the sender
  created_at       INTEGER NOT NULL,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, client_msg_id)
);

-- Uploaded files (R2). Unguessable keys; served by /api/files/:key.
CREATE TABLE files (
  key           TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  uploaded_by   TEXT NOT NULL,   -- 'user:<id>' or 'contact:<id>'
  created_at    INTEGER NOT NULL
);
