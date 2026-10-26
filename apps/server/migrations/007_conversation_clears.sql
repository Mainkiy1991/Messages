CREATE TABLE conversation_clears (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id text NOT NULL,
  cleared_before_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, peer_id)
);
