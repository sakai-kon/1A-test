CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text', 'voice')),
  author TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  object_key TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at DESC);

INSERT OR IGNORE INTO settings(key, value)
VALUES ('siteTitle', '1A 合唱練習サイト');

INSERT OR IGNORE INTO settings(key, value)
VALUES ('songTitle', '合唱曲名を設定してください');
