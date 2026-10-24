CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_msg_id text NOT NULL,
  ciphertext text NOT NULL,
  sender_copy text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz NULL,
  UNIQUE (sender_id, client_msg_id)
);

CREATE INDEX messages_undelivered_recipient_created_idx
  ON messages (recipient_id, created_at)
  WHERE delivered_at IS NULL;
