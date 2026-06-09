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
