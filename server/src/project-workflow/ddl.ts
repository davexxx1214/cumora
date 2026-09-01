export const PROJECT_WORKFLOW_DDL = `
-- Project-owned issue tracking. A group only gains access by mounting the
-- owning project; workflow rows never belong to a conversation directly.
CREATE TABLE IF NOT EXISTS project_workflows (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  issue_prefix    TEXT NOT NULL,
  next_number     INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'closed')),
  version         BIGINT NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL,
  closed_by       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  CONSTRAINT project_workflow_project_pair UNIQUE (id, project_id),
  CONSTRAINT project_workflow_prefix_unique UNIQUE (project_id, issue_prefix)
);
CREATE INDEX IF NOT EXISTS idx_project_workflows_company
  ON project_workflows(company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_work_items (
  id                    TEXT PRIMARY KEY,
  workflow_id           TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  issue_number          INTEGER NOT NULL CHECK (issue_number > 0),
  issue_key             TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('user_story', 'defect', 'subtask')),
  parent_id             TEXT,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'todo'
                          CHECK (status IN ('todo','in_progress','blocked','in_review','done','canceled')),
  priority              TEXT NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('low','medium','high','critical')),
  assignee_id           TEXT,
  assignee_kind         TEXT CHECK (assignee_kind IN ('human','agent')),
  reporter_id           TEXT NOT NULL,
  labels                JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_at                TIMESTAMPTZ,
  rank                  DOUBLE PRECISION NOT NULL DEFAULT 1000,
  version               BIGINT NOT NULL DEFAULT 1,
  user_value            TEXT,
  acceptance_criteria   TEXT,
  story_points          INTEGER CHECK (story_points IS NULL OR (story_points >= 0 AND story_points <= 100)),
  severity              TEXT CHECK (severity IS NULL OR severity IN ('low','medium','high','critical')),
  reproduction_steps    TEXT,
  expected_result       TEXT,
  actual_result         TEXT,
  environment           TEXT,
  resolution            TEXT CHECK (resolution IS NULL OR resolution IN ('fixed','duplicate','cannot_reproduce','wont_fix')),
  archived_at           TIMESTAMPTZ,
  archived_by           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_work_item_workflow_fk FOREIGN KEY (workflow_id, project_id)
    REFERENCES project_workflows(id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_work_item_parent_fk FOREIGN KEY (parent_id)
    REFERENCES project_work_items(id) ON DELETE CASCADE,
  CONSTRAINT project_work_item_number_unique UNIQUE (project_id, issue_number),
  CONSTRAINT project_work_item_key_unique UNIQUE (project_id, issue_key),
  CONSTRAINT project_work_item_assignee_pair CHECK
    ((assignee_id IS NULL AND assignee_kind IS NULL) OR
     (assignee_id IS NOT NULL AND assignee_kind IS NOT NULL)),
  CONSTRAINT project_work_item_type_parent_shape CHECK
    ((type = 'subtask' AND parent_id IS NOT NULL) OR
     (type IN ('user_story','defect') AND parent_id IS NULL)),
  CONSTRAINT project_work_item_resolution_shape CHECK
    (resolution IS NULL OR (type = 'defect' AND status IN ('done','canceled')))
);
CREATE INDEX IF NOT EXISTS idx_project_work_items_workflow_status_rank
  ON project_work_items(workflow_id, status, rank) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_work_items_parent_rank
  ON project_work_items(parent_id, rank) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_work_items_assignee
  ON project_work_items(project_id, assignee_id) WHERE assignee_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_work_items_updated
  ON project_work_items(project_id, updated_at DESC);

-- SQL CHECK constraints cannot inspect the parent row. This trigger guarantees
-- same workflow/project and one subtask level even for direct SQL imports.
CREATE OR REPLACE FUNCTION validate_project_work_item_parent() RETURNS trigger AS $$
DECLARE parent_row project_work_items%ROWTYPE;
BEGIN
  IF NEW.type = 'subtask' THEN
    SELECT * INTO parent_row FROM project_work_items WHERE id = NEW.parent_id;
    IF NOT FOUND OR parent_row.workflow_id <> NEW.workflow_id OR parent_row.project_id <> NEW.project_id
       OR parent_row.type = 'subtask' THEN
      RAISE EXCEPTION 'invalid project workflow parent' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'top-level work item cannot have a parent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_project_work_item_parent ON project_work_items;
CREATE CONSTRAINT TRIGGER trg_project_work_item_parent
AFTER INSERT OR UPDATE OF workflow_id, project_id, type, parent_id ON project_work_items
DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION validate_project_work_item_parent();

CREATE TABLE IF NOT EXISTS project_work_item_comments (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES project_work_items(id) ON DELETE CASCADE,
  author_id       TEXT NOT NULL,
  author_kind     TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
  body            TEXT NOT NULL,
  mentions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  deleted_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_work_item_comments_item
  ON project_work_item_comments(item_id, created_at);

CREATE TABLE IF NOT EXISTS project_work_item_events (
  id                  TEXT PRIMARY KEY,
  workflow_id         TEXT NOT NULL REFERENCES project_workflows(id) ON DELETE CASCADE,
  item_id             TEXT REFERENCES project_work_items(id) ON DELETE SET NULL,
  actor_id            TEXT NOT NULL,
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
  actor_name          TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  changes             JSONB NOT NULL DEFAULT '{}'::jsonb,
  source              TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','agent','system')),
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_work_item_events_item
  ON project_work_item_events(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_work_item_events_workflow
  ON project_work_item_events(workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_work_item_file_links (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES project_work_items(id) ON DELETE CASCADE,
  entry_id        TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  linked_by       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_work_item_file_link_unique UNIQUE (item_id, entry_id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_project_work_item_file_links_item
  ON project_work_item_file_links(item_id, created_at);

CREATE TABLE IF NOT EXISTS project_work_item_commit_links (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES project_work_items(id) ON DELETE CASCADE,
  repository_id   TEXT NOT NULL REFERENCES project_git_repositories(id) ON DELETE CASCADE,
  commit_hash     TEXT NOT NULL,
  summary         TEXT,
  linked_by       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_work_item_commit_link_unique UNIQUE (item_id, repository_id, commit_hash)
);
CREATE INDEX IF NOT EXISTS idx_project_work_item_commit_links_item
  ON project_work_item_commit_links(item_id, created_at);

-- Durable in-app notification inbox. Assignment does not wake an Agent; the
-- explicit execute action is a separate operation and idempotency key.
CREATE TABLE IF NOT EXISTS project_workflow_notifications (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workflow_id         TEXT NOT NULL REFERENCES project_workflows(id) ON DELETE CASCADE,
  item_id             TEXT REFERENCES project_work_items(id) ON DELETE CASCADE,
  recipient_id        TEXT NOT NULL,
  actor_id            TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('assigned','reassigned','blocked','mentioned','agent_execute')),
  dedupe_key          TEXT NOT NULL,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_workflow_notification_dedupe UNIQUE (recipient_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_project_workflow_notifications_recipient
  ON project_workflow_notifications(recipient_id, created_at DESC) WHERE read_at IS NULL;

-- Explicit Agent execution requests are intentionally separate from assignment.
-- A scheduler may consume pending rows later; inserting an assignment never
-- creates one of these rows.
CREATE TABLE IF NOT EXISTS project_work_item_agent_commands (
  id                  TEXT PRIMARY KEY,
  item_id             TEXT NOT NULL REFERENCES project_work_items(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL,
  requested_by        TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  instruction         TEXT NOT NULL DEFAULT '',
  message_id          TEXT REFERENCES messages(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','completed','canceled','failed')),
  run_id              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_work_item_agent_command_unique UNIQUE (item_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_project_work_item_agent_commands_agent
  ON project_work_item_agent_commands(agent_id, status, created_at);
-- Existing validation databases may already have the table from an earlier
-- build of this migration string. Keep this additive migration idempotent.
ALTER TABLE project_work_item_agent_commands
  ADD COLUMN IF NOT EXISTS message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_work_item_agent_commands_message
  ON project_work_item_agent_commands(message_id) WHERE message_id IS NOT NULL;
`
