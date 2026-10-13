-- K-02: uploaded files as a knowledge source (kind 'file'; the original lives in R2, its
-- key and size in settings JSON), and chunks that were stored without a vector because
-- embedding failed (kb_chunks.embedded = 0: keyword search only until a re-index fills it).
--
-- SQLite can't change a CHECK constraint in place, so kb_sources is rebuilt. Dropping it
-- would cascade-delete its documents and chunks, so all three tables are rebuilt: copy into
-- new tables, drop the old ones children first (nothing left to cascade), then rename (which
-- also rewrites the new tables' foreign keys to the final names). Chunk rowids are kept, so
-- the external-content FTS index (kb_chunks_fts) stays valid.

CREATE TABLE kb_sources_new (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('website', 'snippet', 'file')),
  url             TEXT,                             -- website start URL
  title           TEXT NOT NULL,
  body            TEXT,                             -- snippet text
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'ready', 'error')),
  pending_jobs    INTEGER NOT NULL DEFAULT 0,
  page_count      INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  settings        TEXT NOT NULL DEFAULT '{}',       -- JSON: maxPages, robots rules; files: { file: { key, name, format, size } }
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL
);
INSERT INTO kb_sources_new (id, workspace_id, kind, url, title, body, status, pending_jobs, page_count, error, settings, last_synced_at, created_at)
  SELECT id, workspace_id, kind, url, title, body, status, pending_jobs, page_count, error, settings, last_synced_at, created_at FROM kb_sources;

CREATE TABLE kb_documents_new (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL REFERENCES kb_sources_new(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  title           TEXT,
  content_hash    TEXT,
  sync_token      TEXT,
  updated_at      INTEGER NOT NULL,
  UNIQUE (source_id, url)
);
INSERT INTO kb_documents_new (id, workspace_id, source_id, url, title, content_hash, sync_token, updated_at)
  SELECT id, workspace_id, source_id, url, title, content_hash, sync_token, updated_at FROM kb_documents;

CREATE TABLE kb_chunks_new (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  workspace_id  TEXT NOT NULL,
  source_id     TEXT NOT NULL REFERENCES kb_sources_new(id) ON DELETE CASCADE,
  document_id   TEXT REFERENCES kb_documents_new(id) ON DELETE CASCADE,
  url           TEXT,
  title         TEXT NOT NULL,
  heading       TEXT NOT NULL DEFAULT '',
  text          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  embedded      INTEGER NOT NULL DEFAULT 1        -- 0: no vector yet (embedding failed), keyword search only
);
INSERT INTO kb_chunks_new (rowid, id, workspace_id, source_id, document_id, url, title, heading, text, position)
  SELECT rowid, id, workspace_id, source_id, document_id, url, title, heading, text, position FROM kb_chunks;

DROP TRIGGER kb_chunks_ai;
DROP TRIGGER kb_chunks_ad;
DROP TABLE kb_chunks;
DROP TABLE kb_documents;
DROP TABLE kb_sources;

ALTER TABLE kb_sources_new RENAME TO kb_sources;
ALTER TABLE kb_documents_new RENAME TO kb_documents;
ALTER TABLE kb_chunks_new RENAME TO kb_chunks;

CREATE INDEX kb_sources_workspace ON kb_sources(workspace_id);
CREATE INDEX kb_chunks_document ON kb_chunks(document_id);
CREATE INDEX kb_chunks_source ON kb_chunks(source_id);
CREATE INDEX kb_chunks_unembedded ON kb_chunks(source_id) WHERE embedded = 0;

CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, title, heading, text) VALUES (new.rowid, new.title, new.heading, new.text);
END;
CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, heading, text) VALUES ('delete', old.rowid, old.title, old.heading, old.text);
END;
