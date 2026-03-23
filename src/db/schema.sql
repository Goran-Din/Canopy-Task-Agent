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
