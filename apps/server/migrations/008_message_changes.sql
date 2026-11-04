CREATE SEQUENCE messages_change_seq;

ALTER TABLE messages ADD COLUMN deleted_at timestamptz NULL;

ALTER TABLE messages ADD COLUMN change_seq bigint NULL;

CREATE INDEX messages_change_seq_idx
  ON messages (change_seq)
  WHERE change_seq IS NOT NULL;
