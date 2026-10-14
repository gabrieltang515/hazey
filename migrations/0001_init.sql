CREATE TABLE IF NOT EXISTS psi_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  reading_at INTEGER NOT NULL,
  source_updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO refresh_lock (id) VALUES (1);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'sent'))
);
CREATE INDEX IF NOT EXISTS telegram_updates_received_at ON telegram_updates (received_at);
