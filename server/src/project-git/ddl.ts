export const PROJECT_GIT_DDL = `
CREATE TABLE IF NOT EXISTS project_git_access (
  project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  username        TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_hint      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_git_repositories (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  repository_url  TEXT NOT NULL,
  host            TEXT NOT NULL,
  default_branch  TEXT,
  current_branch  TEXT,
  sync_status     TEXT NOT NULL DEFAULT 'not_synced',
  sync_error      TEXT,
  last_synced_at  TIMESTAMPTZ,
  last_commit     TEXT,
  root_entry_id   TEXT,
  updated_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_git_repository_status_check CHECK
    (sync_status IN ('not_synced', 'syncing', 'ready', 'failed')),
  CONSTRAINT project_git_repository_name_unique UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_project_git_repositories_project
  ON project_git_repositories(project_id, created_at);
`
