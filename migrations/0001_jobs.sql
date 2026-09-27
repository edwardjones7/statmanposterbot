-- Job state lives in D1 (strongly consistent) rather than KV: the render job reports
-- "ready" from GitHub's servers while button presses arrive via Telegram's, often at a
-- different Cloudflare location, and KV can serve a stale copy there for up to 60s.

CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL -- the full Job as JSON
);
CREATE INDEX jobs_status_created ON jobs (status, created_at);

-- A pending "✏️ Edit caption": the user's next message becomes that job's caption.
CREATE TABLE caption_edits (
  user_id    INTEGER PRIMARY KEY,
  job_id     TEXT NOT NULL,
  expires_at INTEGER NOT NULL -- unix ms
);
