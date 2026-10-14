CREATE TABLE IF NOT EXISTS pm25_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  reading_at INTEGER NOT NULL,
  source_updated_at INTEGER NOT NULL
);
