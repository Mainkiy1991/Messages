CREATE TABLE devices (
  device_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL
);

CREATE INDEX devices_user_id_idx ON devices(user_id);

ALTER TABLE sessions
  ADD COLUMN device_id text NULL REFERENCES devices(device_id) ON DELETE CASCADE;

CREATE INDEX sessions_device_id_idx ON sessions(device_id);
