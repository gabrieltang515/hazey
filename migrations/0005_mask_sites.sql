-- Free N95 mask collection points saved from HazeMaskGoWhere, one row per file.
CREATE TABLE IF NOT EXISTS mask_sources (
  source TEXT PRIMARY KEY CHECK (source IN ('cc', 'vending')),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source_modified_at INTEGER NOT NULL
);
