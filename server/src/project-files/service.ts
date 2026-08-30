import { randomUUID, createHash, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { CH_CONVO_UPDATED, publish } from '../redis.js'
import { emptyProjectState, fail, type FileActor, type ProjectFileState } from './model.js'
import { LocalProjectObjects } from './objects.js'
import { ProjectFileWorkspace, type FileScope, type FileTransaction } from './workspace.js'
import { readyProjectGit } from '../project-git/service.js'

const SERVER_INSTANCE = randomUUID()
export const filesEnabled = () => env.PROJECT_FILES_ENABLED
export type ProjectFileIdentity =
  | { kind: 'human'; id: string; companyId: string; bindingVersion?: string }
  | { kind: 'lease'; token: string }
interface ProjectRow { id: string; company_id: string; status: string; file_binding_version: string; file_switching: boolean }
interface LeaseRow { id: string; agent_id: string; company_id: string; project_id: string; conversation_id: string; binding_version: string; run_id: string }
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const bindingVersionOf = (project: ProjectRow) => `${project.id}:${project.file_binding_version}`

export function requireProjectFiles(): void {
  if (!filesEnabled() || !env.PROJECT_FILES_ROOT) fail('FILES_DISABLED', 503, 'Project files are not enabled on this host.')
}

async function leaseByToken(client: PoolClient, token: string, lock = false): Promise<LeaseRow> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) fail('REVOKED', 403, 'Invalid project access lease.')
  const { rows } = await client.query<LeaseRow>(
    `SELECT id, agent_id, company_id, project_id, conversation_id, binding_version::text, run_id
       FROM project_file_leases WHERE token_hash = $1 AND revoked_at IS NULL AND stopped_at IS NULL
         AND expires_at > NOW() AND server_instance = $2${lock ? ' FOR SHARE' : ''}`, [hashToken(token), SERVER_INSTANCE])
  if (!rows[0]) fail('REVOKED', 403, 'Project access expired or was revoked.')
  return rows[0]
}

export async function projectLeaseScope(token: string): Promise<LeaseRow> {
  const client = await pool.connect()
  let lease: LeaseRow
  try { lease = await leaseByToken(client, token) } finally { client.release() }
  await projectFilesFor({ kind: 'lease', token }).stat(lease.project_id, 'root')
  return lease
}

export async function currentAgentProject(agentId: string, companyId: string, conversationId: string) {
  requireProjectFiles()
  const { rows } = await pool.query<{ project_id: string | null; file_binding_version: string | null }>(
    `SELECT c.project_id, p.file_binding_version::text FROM conversations c
       LEFT JOIN projects p ON p.id = c.project_id
       JOIN participants a ON a.id = $1 AND a.company_id = c.company_id AND a.kind = 'agent' AND a.departed_at IS NULL
       WHERE c.id = $2 AND c.company_id = $3 AND c.members @> $4::jsonb`,
    [agentId, conversationId, companyId, JSON.stringify([agentId])])
  if (!rows[0]) fail('NOT_FOUND', 404, 'Conversation not found.')
  const projectId = rows[0].project_id
  return { projectId, bindingVersion: projectId ? `${projectId}:${rows[0].file_binding_version}` : null,
    git: projectId ? await readyProjectGit(companyId, projectId) : null }
}

async function authorize(client: PoolClient, project: ProjectRow, identity: ProjectFileIdentity): Promise<FileScope> {
  const { rows: groups } = await client.query<{ id: string; kind: string; company_id: string; members: string[] }>(
    'SELECT id, kind, company_id, members FROM conversations WHERE project_id = $1 FOR SHARE', [project.id])
  if (groups.length > 1 || groups.some(g => g.kind !== 'group' || g.company_id !== project.company_id)) fail('BINDING_CONFLICT', 409, 'This project has incompatible legacy group assignments. An administrator must detach the extra assignments first.')
  const group = groups[0]
  let actor: FileActor
  let admin = false
  let leaseId: string | null = null
  if (identity.kind === 'human') {
    if (identity.companyId !== project.company_id) fail('NOT_FOUND', 404, 'Project not found.')
    const { rows } = await client.query<{ role: string; display_name: string }>(
      `SELECT cm.role, u.display_name FROM company_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.company_id = $1 AND cm.user_id = $2 FOR SHARE OF cm`, [identity.companyId, identity.id])
    if (!rows[0]) fail('NOT_FOUND', 404, 'Project not found.')
    admin = ['owner', 'admin'].includes(rows[0].role)
    if (group ? !group.members.includes(identity.id) : !admin) fail('NOT_FOUND', 404, 'Project not found.')
    if (identity.bindingVersion !== undefined && identity.bindingVersion !== bindingVersionOf(project)) fail('BINDING_CHANGED', 409, 'The group project changed. Refresh before retrying.')
    actor = { id: identity.id, kind: 'human', name: rows[0].display_name }
  } else {
    const lease = await leaseByToken(client, identity.token, true)
    if (lease.project_id !== project.id || lease.company_id !== project.company_id || !group || group.id !== lease.conversation_id ||
        !group.members.includes(lease.agent_id) || String(lease.binding_version) !== String(project.file_binding_version)) fail('REVOKED', 403, 'Project access was revoked.')
    const { rows } = await client.query<{ name: string }>(
      `SELECT name FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'agent' AND departed_at IS NULL FOR SHARE`, [lease.agent_id, lease.company_id])
    if (!rows[0]) fail('REVOKED', 403, 'Agent no longer belongs to this workspace.')
    actor = { id: lease.agent_id, kind: 'agent', name: rows[0].name }; leaseId = lease.id
  }
  return { projectId: project.id, actor, admin, leaseId, bindingVersion: bindingVersionOf(project),
    readOnly: project.status !== 'active' || project.file_switching }
}

/** PostgreSQL row locks serialize all processes on this host. Metadata (bounded
 * per-project JSON) commits in one transaction; binary objects stay private on
 * disk. Missing objects are reconciled by the workspace rather than restored. */
export function projectFilesFor(identity: ProjectFileIdentity): ProjectFileWorkspace {
  requireProjectFiles()
  return new ProjectFileWorkspace({
    async withProject<T>(projectId: string, work: (tx: FileTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const companyId = identity.kind === 'human' ? identity.companyId : (await leaseByToken(client, identity.token)).company_id
        await client.query('SELECT id FROM companies WHERE id = $1 FOR SHARE', [companyId])
        const { rows } = await client.query<ProjectRow>(
          'SELECT id, company_id, status, file_binding_version::text, file_switching FROM projects WHERE id = $1 AND company_id = $2 FOR UPDATE', [projectId, companyId])
        const project = rows[0]
        if (!project) fail('NOT_FOUND', 404, 'Project not found.')
        const scope = await authorize(client, project, identity)
        const { rows: spaces } = await client.query<{ state: ProjectFileState }>('SELECT state FROM project_file_spaces WHERE project_id = $1', [projectId])
        const state = spaces[0]?.state ?? emptyProjectState()
        const previousState = spaces[0] ? JSON.stringify(state) : null
        const previousEventId = state.events.at(-1)?.id
        if (state.schema !== 1) fail('UNSUPPORTED_STATE', 503, 'Unsupported project file metadata version.')
        const leases = Object.values(state.writes).flatMap(w => w.leaseId ? [w.leaseId] : [])
        if (leases.length) {
          const active = await client.query<{ id: string }>(`SELECT id FROM project_file_leases WHERE id = ANY($1::text[]) AND revoked_at IS NULL
            AND stopped_at IS NULL AND expires_at > NOW() AND server_instance = $2`, [leases, SERVER_INSTANCE])
          const ids = new Set(active.rows.map(l => l.id))
          for (const w of Object.values(state.writes)) if (w.leaseId && !ids.has(w.leaseId)) delete state.writes[w.id]
        }
        const value = await work({ state, scope, authorize: async () => { await authorize(client, project, identity) } })
        const nextState = JSON.stringify(state)
        if (nextState !== previousState) await client.query(`INSERT INTO project_file_spaces(project_id, state) VALUES ($1, $2::jsonb)
          ON CONFLICT (project_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`, [projectId, nextState])
        await client.query('COMMIT')
        if (state.events.at(-1)?.id !== previousEventId) {
          const group = await client.query<{ id: string }>('SELECT id FROM conversations WHERE project_id = $1 AND company_id = $2', [projectId, companyId]).catch(() => ({ rows: [] }))
          // Invalidation only; filenames/content never travel on pubsub. The
          // WS bridge intersects the audience with current group membership.
          for (const row of group.rows) await publish(CH_CONVO_UPDATED, {
            type: 'project.files_changed', companyId, conversationId: row.id, projectId, bindingVersion: scope.bindingVersion,
          }).catch(() => {})
        }
        return value
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
  }, new LocalProjectObjects(env.PROJECT_FILES_ROOT))
}

export async function createProjectLease(args: { agentId: string; companyId: string; conversationId: string; runId: string; bindingVersion: string }) {
  requireProjectFiles()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id = $1 FOR SHARE', [args.companyId])
    const { rows } = await client.query<{ project_id: string; members: string[]; kind: string }>(
      'SELECT project_id, members, kind FROM conversations WHERE id = $1 AND company_id = $2 FOR SHARE', [args.conversationId, args.companyId])
    const group = rows[0]
    if (!group || group.kind !== 'group' || !group.members.includes(args.agentId) || !group.project_id) fail('NOT_FOUND', 404, 'No accessible group project.')
    const { rows: projects } = await client.query<ProjectRow>('SELECT id, company_id, status, file_binding_version::text, file_switching FROM projects WHERE id = $1 FOR UPDATE', [group.project_id])
    const project = projects[0]
    if (!project || project.status !== 'active' || project.file_switching || bindingVersionOf(project) !== args.bindingVersion) fail('BINDING_CHANGED', 409, 'The project changed before this task started.')
    const agent = await client.query('SELECT id FROM participants WHERE id = $1 AND company_id = $2 AND kind = \'agent\' AND departed_at IS NULL', [args.agentId, args.companyId])
    if (!agent.rows[0]) fail('REVOKED', 403, 'Agent departed.')
    const run = await client.query("SELECT id FROM agent_runs WHERE id = $1 AND agent_id = $2 AND status = 'running'", [args.runId, args.agentId])
    if (!run.rows[0]) fail('INVALID_RUN', 409, 'An active agent run is required.')
    const id = randomUUID(), token = randomBytes(32).toString('base64url')
    await client.query(`INSERT INTO project_file_leases(id, token_hash, project_id, conversation_id, company_id, agent_id, run_id,
      binding_version, server_instance, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW() + INTERVAL '30 seconds')`,
    [id, hashToken(token), project.id, args.conversationId, args.companyId, args.agentId, args.runId, project.file_binding_version, SERVER_INSTANCE])
    await client.query('COMMIT')
    return { id, token, projectId: project.id, bindingVersion: args.bindingVersion, path: `/projects/${project.id}` }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function heartbeatProjectLease(token: string) {
    // Do not hold a second pool connection while checking the complete scope.
    const lease = await projectLeaseScope(token)
    const result = await pool.query(`UPDATE project_file_leases SET expires_at = NOW() + INTERVAL '30 seconds'
      WHERE id = $1 AND revoked_at IS NULL AND stopped_at IS NULL AND expires_at > NOW()`, [lease.id])
    if (!result.rowCount) fail('REVOKED', 403, 'Project lease expired.')
    return { ok: true }
}

export async function stopProjectLease(args: { id: string; agentId: string; companyId: string }) {
  await pool.query(`UPDATE project_file_leases SET revoked_at = COALESCE(revoked_at, NOW()), stopped_at = NOW()
    WHERE id = $1 AND agent_id = $2 AND company_id = $3`, [args.id, args.agentId, args.companyId])
}
