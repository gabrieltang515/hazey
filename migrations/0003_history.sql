CREATE TABLE IF NOT EXISTS reading_history (
  dataset TEXT NOT NULL CHECK (dataset IN ('psi', 'pm25')),
  reading_at INTEGER NOT NULL,
  source_updated_at INTEGER NOT NULL,
  readings TEXT NOT NULL,
  PRIMARY KEY (dataset, reading_at)
);
