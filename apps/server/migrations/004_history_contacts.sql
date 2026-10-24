CREATE INDEX messages_sender_recipient_seq_idx
  ON messages (sender_id, recipient_id, seq);

CREATE INDEX messages_recipient_sender_seq_idx
  ON messages (recipient_id, sender_id, seq);

CREATE TABLE contact_books (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  blob text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
