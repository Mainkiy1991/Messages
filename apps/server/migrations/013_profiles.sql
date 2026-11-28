CREATE TABLE profiles (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  blob text NOT NULL CHECK (char_length(blob) <= 2048),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_shares (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrap text NOT NULL CHECK (char_length(wrap) <= 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, recipient_id),
  CHECK (owner_id <> recipient_id)
);

CREATE INDEX profile_shares_recipient_idx ON profile_shares(recipient_id, owner_id);
