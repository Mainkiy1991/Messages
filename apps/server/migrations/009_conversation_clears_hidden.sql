ALTER TABLE conversation_clears ADD COLUMN hidden boolean NOT NULL DEFAULT true;
ALTER TABLE conversation_clears ALTER COLUMN hidden SET DEFAULT false;
