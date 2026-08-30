export const PROJECT_GIT_DDL = `
CREATE TABLE IF NOT EXISTS company_git_credentials (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  host            TEXT NOT NULL,
  username        TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_hint      TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_git_credentials_company
  ON company_git_credentials(company_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_active_git_credential
  ON company_git_credentials(company_id) WHERE active;

CREATE TABLE IF NOT EXISTS project_git_settings (
  project_id              TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  repository_url          TEXT NOT NULL,
  default_branch          TEXT,
  resolved_default_branch TEXT,
  sync_status             TEXT NOT NULL DEFAULT 'not_synced',
  sync_error              TEXT,
  last_synced_at          TIMESTAMPTZ,
  last_commit             TEXT,
  updated_by              TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_git_sync_status_check CHECK
    (sync_status IN ('not_synced', 'syncing', 'ready', 'failed'))
);
`
