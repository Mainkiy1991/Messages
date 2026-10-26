CREATE TABLE presence (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL
);
