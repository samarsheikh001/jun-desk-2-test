-- I-14: notifications for agents. One row per browser/device a teammate turned notifications
-- on in (a Web Push subscription). p256dh and auth are the browser's encryption keys for
-- messages to it: needed in plain form to encrypt, never returned by the API. The VAPID private
-- key isn't here: it lives in the workspace hub Durable Object's storage.
CREATE TABLE push_subscriptions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT,
  created_at       INTEGER NOT NULL,
  last_success_at  INTEGER,
  -- Failed sends since the last success (404/410 delete the row instead).
  failures         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (workspace_id, user_id);

-- Which triggers each member wants (JSON, see shared/notifications.ts); missing keys are on.
ALTER TABLE members ADD COLUMN notification_prefs TEXT NOT NULL DEFAULT '{}';
