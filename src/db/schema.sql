-- Users: registered team members authorized to use the agent
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'field', 'staff', 'billing')),
  vikunja_user_id INTEGER,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations: last 10 turns per user for context window
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT REFERENCES users(telegram_id),
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_telegram_id ON conversations(telegram_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);

-- Task history: every task the agent creates or updates
CREATE TABLE IF NOT EXISTS task_history (
  id SERIAL PRIMARY KEY,
  vikunja_task_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  assigned_to BIGINT REFERENCES users(telegram_id),
  created_by BIGINT REFERENCES users(telegram_id),
  sm8_job_uuid VARCHAR(100),
  sm8_client_name VARCHAR(200),
  job_type VARCHAR(50),
  vikunja_label_id INTEGER,
  status VARCHAR(50) DEFAULT 'open',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_vikunja_id ON task_history(vikunja_task_id);
CREATE INDEX IF NOT EXISTS idx_task_sm8_job ON task_history(sm8_job_uuid);
CREATE INDEX IF NOT EXISTS idx_task_job_type ON task_history(job_type);

-- Client context cache: avoids repeat ServiceM8 lookups
CREATE TABLE IF NOT EXISTS client_context (
  id SERIAL PRIMARY KEY,
  client_name VARCHAR(200) NOT NULL,
  sm8_uuid VARCHAR(100) UNIQUE NOT NULL,
  last_job_uuid VARCHAR(100),
  last_job_status VARCHAR(100),
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

-- Config store: rotating credentials (Xero tokens)
CREATE TABLE IF NOT EXISTS config_store (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Nextcloud client folders: tracks auto-created folders in Nextcloud
CREATE TABLE IF NOT EXISTS nc_client_folders (
  id              SERIAL PRIMARY KEY,
  sm8_client_uuid VARCHAR(100) UNIQUE NOT NULL,
  sm8_client_name VARCHAR(200) NOT NULL,
  folder_path     TEXT NOT NULL,
  public_url      TEXT,
  share_password  VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nc_folders_client_uuid ON nc_client_folders(sm8_client_uuid);
CREATE INDEX IF NOT EXISTS idx_nc_folders_client_name ON nc_client_folders(sm8_client_name);

-- Hardscape prospects: the manually-controlled CRM pipeline.
-- stage is one of 9 values (set manually — ServiceM8 status never changes it):
--   request_site_visit, pending_quote, quote_sent, quote_accepted, pending_permits,
--   scheduled_for_work, work_in_progress, completed, lost_opportunity
CREATE TABLE IF NOT EXISTS hardscape_prospects (
  id                  SERIAL PRIMARY KEY,
  sm8_client_uuid     VARCHAR(100) NOT NULL,
  sm8_client_name     VARCHAR(200) NOT NULL,
  sm8_job_uuid        VARCHAR(100),
  sm8_job_number      VARCHAR(50),
  stage               VARCHAR(50) NOT NULL DEFAULT 'request_site_visit'
                        CHECK (stage IN ('request_site_visit', 'pending_quote', 'quote_sent',
                          'quote_accepted', 'pending_permits', 'scheduled_for_work',
                          'work_in_progress', 'completed', 'lost_opportunity')),
  assigned_to         BIGINT REFERENCES users(telegram_id),
  estimated_crew_days INTEGER,
  crew_assignment     VARCHAR(20),
  scheduled_start     DATE,
  client_folder_url   TEXT,
  notes               TEXT,
  scope_summary       TEXT,
  quoted_total        NUMERIC(12,2),
  sm8_status          VARCHAR(30),
  job_address         TEXT,
  matched_by          TEXT[],  -- which detection signals fired: 'creator','category','itemcode'
  design_number       VARCHAR(50),
  hidden              BOOLEAN NOT NULL DEFAULT false,
  hidden_reason       TEXT,
  hidden_at           TIMESTAMPTZ,
  -- Spreadsheet-editable fields (dashboard-only; never written back to ServiceM8).
  gdrive_url             TEXT,    -- pasted Google Drive folder URL (hidden in the UI)
  gdrive_label           TEXT,    -- optional short label / folder number shown as the link text
  follow_up_date         DATE,
  possible_start_date    DATE,
  actual_start_date      DATE,
  -- When true, the user has manually edited this field; the SM8 pull must not overwrite it.
  scope_is_manual        BOOLEAN NOT NULL DEFAULT false,
  quoted_total_is_manual BOOLEAN NOT NULL DEFAULT false,
  sm8_last_synced     TIMESTAMPTZ,
  stage_updated_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent column adds for already-existing hardscape_prospects tables.
-- (CREATE TABLE IF NOT EXISTS above won't alter a pre-existing table, so mirror
--  each spreadsheet-editable column here too — safe to run on every startup.)
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS gdrive_url             TEXT;
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS gdrive_label           TEXT;
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS follow_up_date         DATE;
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS possible_start_date    DATE;
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS actual_start_date      DATE;
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS scope_is_manual        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS quoted_total_is_manual BOOLEAN NOT NULL DEFAULT false;
-- Phase 4a: persisted ServiceM8 project total (job.total_invoice_amount), refreshed
-- on every SM8 pull. Survives the Quote → Work Order conversion (line items don't).
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS project_total          NUMERIC(12,2);
-- Completion dates: sm8_completion_date = ServiceM8's job.completion_date (authoritative,
-- refreshed every SM8 pull, NULL while SM8 hasn't completed the job); completed_at = stamped
-- by the dashboard when WE move a job to stage='completed' (only if still NULL). The feed
-- exposes COALESCE(sm8_completion_date, completed_at) as completed_on.
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS sm8_completion_date    TIMESTAMPTZ;
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS completed_at           TIMESTAMPTZ;
-- ServiceM8 quote-creation timestamp (job.quote_date), refreshed every SM8 pull.
-- The real "when the quote was created" date the List "Date" column shows (our
-- created_at clusters on the seed import date and isn't meaningful). NULL when SM8
-- has no quote_date; the feed exposes it as quote_created_on (Central date).
ALTER TABLE hardscape_prospects ADD COLUMN IF NOT EXISTS sm8_created_date       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_prospects_crew ON hardscape_prospects(crew_assignment);
CREATE INDEX IF NOT EXISTS idx_prospects_sm8_job ON hardscape_prospects(sm8_job_uuid);
-- Dedupe guard: at most one prospect per ServiceM8 job (NULLs allowed for manual rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospects_sm8_job_uuid
  ON hardscape_prospects (sm8_job_uuid) WHERE sm8_job_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON hardscape_prospects(stage);

-- Prospect comments: per-prospect activity log (manual notes + ServiceM8 activity sync).
CREATE TABLE IF NOT EXISTS prospect_comments (
  id                SERIAL PRIMARY KEY,
  prospect_id       INTEGER NOT NULL REFERENCES hardscape_prospects(id) ON DELETE CASCADE,
  source            VARCHAR(20) NOT NULL,
  author            VARCHAR(100),
  content           TEXT NOT NULL,
  sm8_activity_uuid VARCHAR(100),
  editable          BOOLEAN DEFAULT false,
  activity_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_prospect ON prospect_comments(prospect_id);
CREATE INDEX IF NOT EXISTS idx_comments_sm8_uuid ON prospect_comments(sm8_activity_uuid);

-- Crew schedule: hardscape crew (HP#1/HP#2) bookings against a prospect.
CREATE TABLE IF NOT EXISTS crew_schedule (
  id             SERIAL PRIMARY KEY,
  prospect_id    INTEGER NOT NULL REFERENCES hardscape_prospects(id) ON DELETE CASCADE,
  crew           VARCHAR(20) NOT NULL,
  start_date     DATE NOT NULL,
  estimated_days INTEGER NOT NULL DEFAULT 1,
  actual_days    INTEGER,
  status         VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  delay_reason   TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  crew_size      INTEGER DEFAULT 2,
  crew_members   TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedule_crew ON crew_schedule(crew);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON crew_schedule(start_date);
CREATE INDEX IF NOT EXISTS idx_schedule_prospect ON crew_schedule(prospect_id);

-- Invoice cache: Xero invoice status per ServiceM8 job (landscape + hardscape), drives the badges.
CREATE TABLE IF NOT EXISTS invoice_cache (
  id              SERIAL PRIMARY KEY,
  sm8_job_uuid    VARCHAR(100) NOT NULL,
  sm8_client_name VARCHAR(200) NOT NULL,
  division        VARCHAR(20) NOT NULL,
  xero_invoice_id VARCHAR(100),
  invoice_number  VARCHAR(50),
  invoice_amount  NUMERIC(10,2),
  invoice_status  VARCHAR(30) DEFAULT 'not_invoiced',
  due_date        DATE,
  paid_date       DATE,
  last_synced_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_cache_job ON invoice_cache(sm8_job_uuid);
CREATE INDEX IF NOT EXISTS idx_invoice_cache_client ON invoice_cache(sm8_client_name);
CREATE INDEX IF NOT EXISTS idx_invoice_cache_division ON invoice_cache(division);
CREATE INDEX IF NOT EXISTS idx_invoice_cache_status ON invoice_cache(invoice_status);

-- Prospect invoices (Phase 4a): ALL Xero invoices attached to a hardscape prospect
-- (multiple per prospect), plus manual rows. The new billing source the Completed
-- view reads in 4b. invoice_cache (above) stays as the single-match badge source.
--   • source = 'xero'   — synced from Xero by invoiceSync; upserted by xero_invoice_id.
--   • source = 'manual' — hand-entered; never touched by the sync.
-- status holds the RAW Xero status (paid / authorised / voided); the display status
-- (Paid / Invoiced / Overdue) is computed on read in the feed (Overdue = unpaid past
-- due_date in America/Chicago), never stored.
CREATE TABLE IF NOT EXISTS prospect_invoices (
  id              SERIAL PRIMARY KEY,
  prospect_id     INTEGER NOT NULL REFERENCES hardscape_prospects(id) ON DELETE CASCADE,
  invoice_number  TEXT,
  amount          NUMERIC,
  note            TEXT,                       -- the raw Xero Reference (for source='xero')
  source          TEXT NOT NULL DEFAULT 'manual',
  xero_invoice_id TEXT,
  status          TEXT,                       -- raw Xero status: paid / authorised / voided
  due_date        DATE,
  paid_date       DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospect_invoices_prospect ON prospect_invoices(prospect_id);
CREATE INDEX IF NOT EXISTS idx_prospect_invoices_source ON prospect_invoices(source);
-- Idempotency: at most one row per Xero invoice (manual rows keep NULL xero_invoice_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_invoices_xero
  ON prospect_invoices (xero_invoice_id) WHERE xero_invoice_id IS NOT NULL;

-- Job comments: one editable note per ServiceM8 job (landscape + hardscape); upserted on sm8_job_uuid.
CREATE TABLE IF NOT EXISTS job_comments (
  id              SERIAL PRIMARY KEY,
  sm8_job_uuid    VARCHAR(100) NOT NULL,
  sm8_client_name VARCHAR(200),
  division        VARCHAR(20) NOT NULL,
  comment_text    TEXT NOT NULL,
  created_by      BIGINT REFERENCES users(telegram_id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_comments_job ON job_comments(sm8_job_uuid);
CREATE INDEX IF NOT EXISTS idx_job_comments_division ON job_comments(division);

-- Completion notifications: per-user opt-in for job-completion alerts by division.
CREATE TABLE IF NOT EXISTS completion_notifications (
  id          SERIAL PRIMARY KEY,
  telegram_id BIGINT REFERENCES users(telegram_id),
  job_types   TEXT[] NOT NULL DEFAULT ARRAY['landscape_project', 'hardscape']::text[],
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Deposit tracker: staged deposit/progress payments per project (landscape + hardscape).
CREATE TABLE IF NOT EXISTS deposit_tracker (
  id                   SERIAL PRIMARY KEY,
  project_type         VARCHAR(20) NOT NULL CHECK (project_type IN ('hardscape', 'landscape')),
  client_name          VARCHAR(200) NOT NULL,
  sm8_job_uuid         VARCHAR(100),
  sm8_job_number       VARCHAR(20),
  total_project_amount NUMERIC(10,2),
  payment_terms        TEXT,
  deposit_xero_inv_id  VARCHAR(100),
  deposit_inv_number   VARCHAR(50),
  deposit_amount       NUMERIC(10,2),
  deposit_paid_date    DATE,
  payment2_xero_inv_id VARCHAR(100),
  payment2_inv_number  VARCHAR(50),
  payment2_amount      NUMERIC(10,2),
  payment2_paid_date   DATE,
  payment3_xero_inv_id VARCHAR(100),
  payment3_inv_number  VARCHAR(50),
  payment3_amount      NUMERIC(10,2),
  payment3_paid_date   DATE,
  final_xero_inv_id    VARCHAR(100),
  final_inv_number     VARCHAR(50),
  final_amount         NUMERIC(10,2),
  final_paid_date      DATE,
  balance_due          NUMERIC(10,2),
  status               VARCHAR(30) DEFAULT 'Awaiting Deposit',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dt_job ON deposit_tracker(sm8_job_number);
CREATE INDEX IF NOT EXISTS idx_dt_status ON deposit_tracker(status);

-- Knowledge base: free-text reference entries with full-text search + tag indexes.
CREATE TABLE IF NOT EXISTS knowledge_base (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  tags       TEXT[] DEFAULT '{}'::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_kb_search ON knowledge_base
  USING gin (to_tsvector('english', (title || ' ') || content));
CREATE INDEX IF NOT EXISTS idx_kb_tags ON knowledge_base USING gin (tags);

-- ---------------------------------------------------------------------------
-- Client directory (Phase A): synced SM8 <-> Xero client match table. Built by
-- the clientDirectorySync worker — READ-ONLY against SM8/Xero, writes only here.
-- One row per directory_key: 'sm8:<company_uuid>' for an SM8 company (the spine)
-- or 'xero:<contact_id>' for a Xero contact with no SM8 match. Upserted on
-- directory_key so the worker is fully re-runnable. The future Clients tab reads
-- this table; matching uses unique, non-denylisted email/phone (never a shared id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_directory (
  id                 SERIAL PRIMARY KEY,
  directory_key      TEXT NOT NULL,                 -- 'sm8:<uuid>' | 'xero:<contactid>'
  canonical_name     TEXT,
  sm8_company_name   TEXT,
  xero_contact_name  TEXT,
  sm8_company_uuids  TEXT[] DEFAULT '{}'::text[],   -- >1 when SM8-side duplicated
  xero_contact_ids   TEXT[] DEFAULT '{}'::text[],   -- >1 when matched/duplicated in Xero
  match_email        TEXT,                          -- the usable unique email actually used
  match_phone        TEXT,                          -- the usable unique phone actually used
  match_signal       TEXT NOT NULL DEFAULT 'none',  -- email | phone | name | none
  match_confidence   TEXT NOT NULL DEFAULT 'none',  -- high | medium | none
  in_sm8             BOOLEAN NOT NULL DEFAULT false,
  in_xero            BOOLEAN NOT NULL DEFAULT false,
  dup_in_sm8         BOOLEAN NOT NULL DEFAULT false,
  dup_in_xero        BOOLEAN NOT NULL DEFAULT false,
  missing_from_xero  BOOLEAN NOT NULL DEFAULT false, -- in SM8, no Xero match
  missing_from_sm8   BOOLEAN NOT NULL DEFAULT false, -- in Xero, no SM8 match
  has_accepted_quote BOOLEAN NOT NULL DEFAULT false,
  accepted_categories TEXT[] DEFAULT '{}'::text[],   -- distinct category names of WON jobs
  created_by_rep      TEXT,                          -- SM8 staff who created the company's jobs
  created_by_rep_uuid TEXT,
  last_synced        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase A.1: evidence-based duplicate detection. dup_confidence = strong (shared
-- email/phone in a banded cluster, size 2..N) | possible (shared exact name only).
-- The *_dup_group_key columns let the future Duplicates tab cluster rows: every row
-- sharing a normalized identifier carries the same key.
ALTER TABLE client_directory ADD COLUMN IF NOT EXISTS dup_confidence     TEXT;
ALTER TABLE client_directory ADD COLUMN IF NOT EXISTS dup_reason         TEXT;
ALTER TABLE client_directory ADD COLUMN IF NOT EXISTS sm8_dup_group_key  TEXT;
ALTER TABLE client_directory ADD COLUMN IF NOT EXISTS xero_dup_group_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_directory_key ON client_directory(directory_key);
CREATE INDEX IF NOT EXISTS idx_client_directory_missing_xero ON client_directory(missing_from_xero);
CREATE INDEX IF NOT EXISTS idx_client_directory_rep ON client_directory(created_by_rep);
CREATE INDEX IF NOT EXISTS idx_client_directory_accepted ON client_directory(has_accepted_quote);
CREATE INDEX IF NOT EXISTS idx_client_directory_sm8_dupkey  ON client_directory(sm8_dup_group_key);
CREATE INDEX IF NOT EXISTS idx_client_directory_xero_dupkey ON client_directory(xero_dup_group_key);
