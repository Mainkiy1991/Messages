CREATE TABLE pin_settings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  blob text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
