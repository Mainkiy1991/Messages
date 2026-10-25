CREATE TABLE read_markers (
  reader_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_up_to_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reader_id, peer_id)
);
