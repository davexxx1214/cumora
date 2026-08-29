/** Additive migration. Existing conflicting project assignments are left intact
 * and rejected by the file-service gate until an administrator resolves them. */
export const PROJECT_FILES_DDL = `
ALTER TABLE projects ADD COLUMN IF NOT EXISTS file_binding_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS file_switching BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS project_file_spaces (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS project_file_bindings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO project_file_bindings(project_id, conversation_id)
  SELECT p.id, MIN(c.id) FROM projects p JOIN conversations c ON c.project_id = p.id
  GROUP BY p.id HAVING COUNT(*) = 1 AND BOOL_AND(c.kind = 'group' AND c.company_id = p.company_id)
  ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS project_file_leases (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  binding_version BIGINT NOT NULL,
  server_instance TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_file_leases_group ON project_file_leases(conversation_id) WHERE stopped_at IS NULL;

CREATE OR REPLACE FUNCTION cumora_project_binding_guard() RETURNS TRIGGER AS $$
DECLARE target projects%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' AND OLD.project_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM project_file_leases WHERE conversation_id = OLD.id AND stopped_at IS NULL) THEN
      RAISE EXCEPTION 'project tasks must stop before changing the binding' USING ERRCODE = '23514';
    END IF;
    DELETE FROM project_file_bindings WHERE conversation_id = OLD.id;
    UPDATE projects SET file_binding_version = file_binding_version + 1, file_switching = FALSE WHERE id = OLD.project_id;
    UPDATE project_file_leases SET revoked_at = COALESCE(revoked_at, NOW()) WHERE conversation_id = OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.project_id IS NOT NULL THEN
    SELECT * INTO target FROM projects WHERE id = NEW.project_id FOR UPDATE;
    IF target.id IS NULL OR target.company_id <> NEW.company_id OR NEW.kind <> 'group' OR target.status <> 'active' OR target.file_switching THEN
      RAISE EXCEPTION 'project must be active and belong to the group workspace' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM conversations WHERE project_id = NEW.project_id AND id <> NEW.id) THEN
      RAISE EXCEPTION 'project already attached to another group' USING ERRCODE = '23505';
    END IF;
    INSERT INTO project_file_bindings(project_id, conversation_id) VALUES (NEW.project_id, NEW.id);
    UPDATE projects SET file_binding_version = file_binding_version + 1 WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS project_binding_guard ON conversations;
CREATE TRIGGER project_binding_guard AFTER INSERT OR UPDATE OF project_id OR DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION cumora_project_binding_guard();

CREATE OR REPLACE FUNCTION cumora_project_member_revoke() RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'conversations' THEN
    UPDATE project_file_leases SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE conversation_id = NEW.id AND NOT NEW.members @> jsonb_build_array(agent_id);
  ELSE
    UPDATE project_file_leases SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE company_id = NEW.company_id AND agent_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS project_member_revoke ON conversations;
CREATE TRIGGER project_member_revoke AFTER UPDATE OF members ON conversations
  FOR EACH ROW EXECUTE FUNCTION cumora_project_member_revoke();
DROP TRIGGER IF EXISTS project_agent_revoke ON participants;
CREATE TRIGGER project_agent_revoke AFTER UPDATE OF departed_at ON participants
  FOR EACH ROW WHEN (NEW.departed_at IS NOT NULL) EXECUTE FUNCTION cumora_project_member_revoke();

CREATE OR REPLACE FUNCTION cumora_project_archive_revoke() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    IF EXISTS (SELECT 1 FROM project_file_leases WHERE project_id = NEW.id AND stopped_at IS NULL) THEN
      RAISE EXCEPTION 'project tasks must stop before archiving' USING ERRCODE = '23514';
    END IF;
    NEW.file_binding_version := OLD.file_binding_version + 1;
    UPDATE project_file_leases SET revoked_at = COALESCE(revoked_at, NOW()) WHERE project_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS project_archive_revoke ON projects;
CREATE TRIGGER project_archive_revoke BEFORE UPDATE OF status ON projects
  FOR EACH ROW EXECUTE FUNCTION cumora_project_archive_revoke();
`
