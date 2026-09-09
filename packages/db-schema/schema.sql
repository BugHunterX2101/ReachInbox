-- Canonical schema — ReachInbox Email Job Scheduler
-- Postgres is the durable record of intent and outcome (PRD FR-9).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  max_emails_per_hour   INT NOT NULL DEFAULT 500, -- overrides MAX_EMAILS_PER_HOUR env default when set per-row
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  google_id     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS senders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  name                  TEXT NOT NULL,
  from_address          TEXT NOT NULL,
  smtp_host             TEXT NOT NULL,
  smtp_port             INT NOT NULL,
  smtp_user             TEXT NOT NULL,
  smtp_pass_encrypted   TEXT NOT NULL,          -- app-level AES-256-GCM
  max_emails_per_hour   INT NOT NULL DEFAULT 100, -- overrides MAX_EMAILS_PER_HOUR_PER_SENDER env default when set per-row
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_address)
);

CREATE TABLE IF NOT EXISTS batches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  created_by                UUID NOT NULL REFERENCES users(id),
  sender_id                 UUID NOT NULL REFERENCES senders(id),
  subject                   TEXT NOT NULL,
  body                      TEXT NOT NULL,
  start_time                TIMESTAMPTZ NOT NULL,
  delay_between_sends_ms    INT NOT NULL DEFAULT 0,
  hourly_limit_override     INT,                -- optional per-batch cap; falls back to sender/tenant defaults
  requested_count           INT NOT NULL,
  scheduled_count           INT NOT NULL DEFAULT 0, -- filled in as async expansion completes (FR-6)
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batch_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  storage_url     TEXT NOT NULL,     -- S3-compatible object storage
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES batches(id),
  tenant_id         UUID NOT NULL REFERENCES tenants(id), -- denormalized: hot-path rate checks & tenant-scoped queries avoid a join
  sender_id         UUID NOT NULL REFERENCES senders(id),
  recipient         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'processing', 'sent', 'failed')), -- exact enum from PRD §11
  bullmq_job_id     TEXT NOT NULL UNIQUE,     -- deterministic: sha256(batchId:recipient).slice(0,32)
  attempts          INT NOT NULL DEFAULT 0,   -- DB mirror of BullMQ attemptsMade
  last_error        TEXT,
  locked_at         TIMESTAMPTZ,              -- processing-lease start; NULL unless status = processing
  locked_by         TEXT,                     -- worker instance id holding the lease
  scheduled_at      TIMESTAMPTZ NOT NULL,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (batch, recipient): app-level idempotency backstop beneath BullMQ's own jobId dedup (FR-8, FR-12)
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_jobs_batch_recipient ON email_jobs (batch_id, recipient);

-- Dashboard list queries (Scheduled/Sent) and the reconciler's boot-time scan
CREATE INDEX IF NOT EXISTS idx_email_jobs_status_scheduled_at ON email_jobs (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_email_jobs_tenant_status ON email_jobs (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_email_jobs_sender_status ON email_jobs (sender_id, status);

-- Fast lookup of leases the reconciler needs to reclaim
CREATE INDEX IF NOT EXISTS idx_email_jobs_processing_locked_at ON email_jobs (locked_at) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS slack_integrations (
  tenant_id                 UUID PRIMARY KEY REFERENCES tenants(id),
  access_token_encrypted    TEXT,
  webhook_url               TEXT,
  connected_by              UUID REFERENCES users(id),
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Absence of a row for a tenant means "not connected" (FR-24) — no boolean flag needed.

CREATE TABLE IF NOT EXISTS recipient_uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  filename        TEXT NOT NULL,
  valid_count     INT NOT NULL,
  invalid_count   INT NOT NULL,
  invalid_samples JSONB NOT NULL DEFAULT '[]',
  recipients      JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
