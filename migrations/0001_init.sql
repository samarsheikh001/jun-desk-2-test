-- M0: workspaces, users, members, passkey auth, sessions.
-- Multi-workspace from day one (D-09); self-hosted v1 shows a single workspace.
-- IDs are app-generated text; timestamps are Unix epoch milliseconds.

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE COLLATE NOCASE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE members (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'agent')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

-- WebAuthn credentials. Passkeys are bound to the hostname they were created on (rp_id).
CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,           -- credential ID, base64url
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,              -- COSE public key, base64url
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                       -- JSON array
  device_type   TEXT,                       -- 'singleDevice' | 'multiDevice'
  backed_up     INTEGER NOT NULL DEFAULT 0,
  rp_id         TEXT NOT NULL,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- Only the SHA-256 hash of the session token is stored.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Pending WebAuthn ceremonies. `payload` holds what to do on success (JSON).
CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('setup', 'recover', 'invite', 'add_passkey', 'login')),
  payload     TEXT NOT NULL DEFAULT '{}',
  expires_at  INTEGER NOT NULL
);

-- Invite links for new members. Only the hash of the invite token is stored.
CREATE TABLE invites (
  token_hash    TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
