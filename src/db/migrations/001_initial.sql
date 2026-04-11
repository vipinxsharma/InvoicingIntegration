-- ═══════════════════════════════════════════════════════════════════════════
-- Billing Integration Service – Initial Schema
-- ═══════════════════════════════════════════════════════════════════════════

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Trigger helper ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── contracts ───────────────────────────────────────────────────────────────
-- One row per Bitrix24 deal; holds both raw and parsed contract terms.
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bitrix_deal_id  VARCHAR(50) NOT NULL,
  raw_text        TEXT        NOT NULL,
  parsed_terms    JSONB       NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_contracts_deal UNIQUE (bitrix_deal_id)
);

CREATE TRIGGER trg_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── billing_schedules ───────────────────────────────────────────────────────
-- One row per billing stream.  Hybrid contracts produce multiple rows.
CREATE TABLE IF NOT EXISTS billing_schedules (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  bitrix_deal_id  VARCHAR(50) NOT NULL,
  billing_type    VARCHAR(20) NOT NULL
                  CHECK (billing_type IN
                    ('monthly','quarterly','annual','one_time','milestone')),
  amount          DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  currency        CHAR(3)     NOT NULL DEFAULT 'USD',
  start_date      DATE        NOT NULL,
  end_date        DATE,
  -- For recurring schedules: day of month to trigger invoice (1-28)
  day_of_month    SMALLINT    CHECK (day_of_month BETWEEN 1 AND 28),
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_billing_schedules_updated_at
  BEFORE UPDATE ON billing_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── billing_milestones ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_milestones (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  UUID        NOT NULL REFERENCES billing_schedules(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  amount       DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  due_date     DATE        NOT NULL,
  description  TEXT,
  is_billed    BOOLEAN     NOT NULL DEFAULT FALSE,
  billed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_billing_milestones_updated_at
  BEFORE UPDATE ON billing_milestones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── entity_mappings ─────────────────────────────────────────────────────────
-- Persists the Bitrix24 ↔ LEDGERS entity relationship.
CREATE TABLE IF NOT EXISTS entity_mappings (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bitrix_entity_type   VARCHAR(50) NOT NULL
                       CHECK (bitrix_entity_type IN ('deal','contact','company')),
  bitrix_entity_id     VARCHAR(50) NOT NULL,
  ledgers_entity_type  VARCHAR(50) NOT NULL
                       CHECK (ledgers_entity_type IN ('contact','catalog_item','invoice')),
  ledgers_entity_id    VARCHAR(255) NOT NULL,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_entity_mapping
    UNIQUE (bitrix_entity_type, bitrix_entity_id, ledgers_entity_type)
);

CREATE TRIGGER trg_entity_mappings_updated_at
  BEFORE UPDATE ON entity_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── invoice_records ─────────────────────────────────────────────────────────
-- Every invoice attempt is recorded here.  idempotency_key is the primary
-- guard against double-billing.
CREATE TABLE IF NOT EXISTS invoice_records (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id            UUID         NOT NULL REFERENCES billing_schedules(id) ON DELETE RESTRICT,
  milestone_id           UUID         REFERENCES billing_milestones(id) ON DELETE RESTRICT,
  bitrix_deal_id         VARCHAR(50)  NOT NULL,
  ledgers_invoice_id     VARCHAR(255),
  ledgers_invoice_number VARCHAR(100),
  -- Format: {scheduleId}::{billingType}::{periodStart}::{periodEnd}
  idempotency_key        VARCHAR(500) NOT NULL,
  period_start           DATE         NOT NULL,
  period_end             DATE         NOT NULL,
  amount                 DECIMAL(15,2) NOT NULL,
  currency               CHAR(3)      NOT NULL DEFAULT 'USD',
  status                 VARCHAR(20)  NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','created','failed','cancelled')),
  error_message          TEXT,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_invoice_idempotency UNIQUE (idempotency_key)
);

CREATE TRIGGER trg_invoice_records_updated_at
  BEFORE UPDATE ON invoice_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── audit_logs ──────────────────────────────────────────────────────────────
-- Immutable append-only log.  No updates trigger needed.
CREATE TABLE IF NOT EXISTS audit_logs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type          VARCHAR(100) NOT NULL,
  entity_type         VARCHAR(50),
  entity_id           VARCHAR(255),
  bitrix_deal_id      VARCHAR(50),
  ledgers_invoice_id  VARCHAR(255),
  payload             JSONB,
  result              JSONB,
  success             BOOLEAN     NOT NULL,
  error_message       TEXT,
  ip_address          VARCHAR(45),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── error_queue ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS error_queue (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_record_id UUID        REFERENCES invoice_records(id) ON DELETE SET NULL,
  schedule_id       UUID        NOT NULL REFERENCES billing_schedules(id) ON DELETE CASCADE,
  error_type        VARCHAR(100) NOT NULL,
  error_message     TEXT        NOT NULL,
  error_stack       TEXT,
  context           JSONB,
  attempts          INTEGER     NOT NULL DEFAULT 0,
  max_attempts      INTEGER     NOT NULL DEFAULT 5,
  next_retry_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','retrying','resolved','dead_letter')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_error_queue_updated_at
  BEFORE UPDATE ON error_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── idempotency_keys ────────────────────────────────────────────────────────
-- 24-hour window for webhook request deduplication.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         VARCHAR(500) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'processing'
              CHECK (status IN ('processing','completed','failed')),
  response    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  CONSTRAINT uq_idempotency_key UNIQUE (key)
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_contracts_deal
  ON contracts (bitrix_deal_id);

CREATE INDEX IF NOT EXISTS idx_schedules_contract
  ON billing_schedules (contract_id);
CREATE INDEX IF NOT EXISTS idx_schedules_deal
  ON billing_schedules (bitrix_deal_id);
CREATE INDEX IF NOT EXISTS idx_schedules_active
  ON billing_schedules (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_schedules_type
  ON billing_schedules (billing_type);

CREATE INDEX IF NOT EXISTS idx_milestones_schedule
  ON billing_milestones (schedule_id);
CREATE INDEX IF NOT EXISTS idx_milestones_due
  ON billing_milestones (due_date);
CREATE INDEX IF NOT EXISTS idx_milestones_unbilled
  ON billing_milestones (is_billed, due_date) WHERE is_billed = FALSE;

CREATE INDEX IF NOT EXISTS idx_entity_mappings_bitrix
  ON entity_mappings (bitrix_entity_type, bitrix_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_mappings_ledgers
  ON entity_mappings (ledgers_entity_type, ledgers_entity_id);

CREATE INDEX IF NOT EXISTS idx_invoice_records_schedule
  ON invoice_records (schedule_id);
CREATE INDEX IF NOT EXISTS idx_invoice_records_deal
  ON invoice_records (bitrix_deal_id);
CREATE INDEX IF NOT EXISTS idx_invoice_records_status
  ON invoice_records (status);
CREATE INDEX IF NOT EXISTS idx_invoice_records_period
  ON invoice_records (period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_invoice_records_ledgers
  ON invoice_records (ledgers_invoice_id)
  WHERE ledgers_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_deal
  ON audit_logs (bitrix_deal_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event
  ON audit_logs (event_type);

CREATE INDEX IF NOT EXISTS idx_error_queue_status
  ON error_queue (status);
CREATE INDEX IF NOT EXISTS idx_error_queue_retry
  ON error_queue (next_retry_at, status)
  WHERE status IN ('pending','retrying');

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_keys (expires_at);
