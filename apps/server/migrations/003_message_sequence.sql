ALTER TABLE messages
  ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE INDEX messages_undelivered_recipient_seq_idx
  ON messages (recipient_id, seq)
  WHERE delivered_at IS NULL;
