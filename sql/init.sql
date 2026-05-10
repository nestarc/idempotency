-- @nestarc/idempotency v0.2.0+ schema
-- Idempotent: safe to run multiple times.
-- Required Postgres version: 12+ (verified on 16).

CREATE TABLE IF NOT EXISTS idempotency_records (
  key            TEXT        PRIMARY KEY,
  token          UUID        NOT NULL,
  fingerprint    TEXT,
  status         TEXT        NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
  response_code  INT,
  response_body  TEXT,
  response_headers JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
  ON idempotency_records (expires_at);
