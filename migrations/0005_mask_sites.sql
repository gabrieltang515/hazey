-- Free N95 mask collection points saved from HazeMaskGoWhere, one row per file.
CREATE TABLE IF NOT EXISTS mask_sources (
  source TEXT PRIMARY KEY CHECK (source IN ('cc', 'vending')),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source_modified_at INTEGER NOT NULL
);

-- A private chat that sent plain /masks: its next shared location within ten minutes gets mask points.
-- Only the chat ID is kept, never the location.
CREATE TABLE IF NOT EXISTS bot_location_requests (
  chat_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('masks')),
  expires_at INTEGER NOT NULL
);
