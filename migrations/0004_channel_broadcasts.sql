-- Durable reporting mode and lease for each configured Telegram channel.
CREATE TABLE IF NOT EXISTS channel_broadcasts (
  channel_id TEXT PRIMARY KEY,
  alert_active INTEGER NOT NULL DEFAULT 0 CHECK (alert_active IN (0, 1)),
  pending_breach INTEGER NOT NULL DEFAULT 0 CHECK (pending_breach IN (0, 1)),
  reading_at INTEGER NOT NULL DEFAULT -1,
  source_updated_at INTEGER NOT NULL DEFAULT -1,
  last_slot INTEGER NOT NULL DEFAULT -1,
  owner TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0
);
