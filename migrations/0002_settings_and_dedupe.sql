-- Small key/value settings that change at runtime, e.g. the Instagram access token,
-- which is refreshed every week (it expires 60 days after each refresh).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL -- unix ms
);

-- Telegram update ids already handled. Telegram re-sends an update if the webhook is
-- slow to answer; this makes each update run once (e.g. a post is never published twice).
CREATE TABLE processed_updates (
  update_id    INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL -- unix ms
);
