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
  sm8_last_synced     TIMESTAMPTZ,
  stage_updated_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

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
