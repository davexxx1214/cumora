import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { fail } from './model.js'

export async function requireProjectAdmin(client: PoolClient, companyId: string, userId: string): Promise<void> {
  const { rows } = await client.query<{ role: string }>('SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2', [companyId, userId])
  if (!rows[0] || !['owner', 'admin'].includes(rows[0].role)) fail('ADMIN_REQUIRED', 403, 'A workspace administrator is required.')
}

export async function requireProjectManager(client: PoolClient, companyId: string, userId: string, projectId: string): Promise<string | null> {
  await requireProjectAdmin(client, companyId, userId)
  const project = await client.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2 FOR UPDATE', [projectId, companyId])
  if (!project.rows[0]) fail('NOT_FOUND', 404, 'Project not found.')
  const groups = await client.query<{ id: string; members: string[] }>('SELECT id, members FROM conversations WHERE project_id = $1', [projectId])
  if (groups.rows.some(g => !g.members.includes(userId))) fail('NOT_FOUND', 404, 'Project not found.')
  if (groups.rows.length > 1) fail('BINDING_CONFLICT', 409, 'Resolve the legacy project bindings first.')
  return groups.rows[0]?.id ?? null
}

export async function archiveProject(companyId: string, userId: string, projectId: string, archive: boolean): Promise<void> {
  const client = await pool.connect()
  let groupId: string | null
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId])
    groupId = await requireProjectManager(client, companyId, userId, projectId)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  if (groupId) await prepareGroupProjectStop(companyId, userId, groupId)
  const update = await pool.connect()
  try {
    await update.query('BEGIN')
    await update.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId])
    await requireProjectManager(update, companyId, userId, projectId)
    const pending = await update.query('SELECT 1 FROM project_file_leases WHERE project_id = $1 AND stopped_at IS NULL LIMIT 1', [projectId])
    if (pending.rows[0]) fail('TASKS_STOPPING', 409, 'Project tasks have not stopped yet.')
    await update.query(`UPDATE projects SET status = $2, archived_at = CASE WHEN $3 THEN NOW() ELSE NULL END, file_switching = FALSE WHERE id = $1`,
      [projectId, archive ? 'archived' : 'active', archive])
    await update.query('COMMIT')
  } catch (error) { await update.query('ROLLBACK'); throw error } finally { update.release() }
}

export async function validateNewProjectBinding(client: PoolClient, companyId: string, userId: string, projectId: string, conversationId?: string): Promise<void> {
  await requireProjectAdmin(client, companyId, userId)
  const { rows } = await client.query<{ status: string; file_switching: boolean }>(
    'SELECT status, file_switching FROM projects WHERE id = $1 AND company_id = $2 FOR UPDATE', [projectId, companyId])
  if (!rows[0]) fail('NOT_FOUND', 404, 'Project not found.')
  if (rows[0].status !== 'active' || rows[0].file_switching) fail('PROJECT_UNAVAILABLE', 409, 'The project is archived or waiting for tasks to stop.')
  const attached = await client.query('SELECT id FROM conversations WHERE project_id = $1 AND ($2::text IS NULL OR id <> $2) LIMIT 1', [projectId, conversationId ?? null])
  if (attached.rows[0]) fail('PROJECT_IN_USE', 409, 'This project is already mounted by another group.')
}

/** Stop is deliberately a committed step. A failed/timed-out switch must leave
 * old leases revoked instead of reviving them through transaction rollback. The
 * runner acknowledges only after its process tree and mount have exited. */
export async function prepareGroupProjectStop(companyId: string, userId: string, conversationId: string): Promise<void> {
  const client = await pool.connect()
  let pending = 0
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId])
    await requireProjectAdmin(client, companyId, userId)
    const { rows } = await client.query<{ project_id: string | null; kind: string; members: string[] }>(
      'SELECT project_id, kind, members FROM conversations WHERE id = $1 AND company_id = $2 FOR UPDATE', [conversationId, companyId])
    const group = rows[0]
    if (!group || !group.members.includes(userId)) fail('NOT_FOUND', 404, 'Group not found.')
    if (group.kind !== 'group') fail('NOT_GROUP', 400, 'Only group chats have project bindings.')
    if (group.project_id) {
      await client.query('UPDATE projects SET file_switching = TRUE WHERE id = $1', [group.project_id])
      await client.query('UPDATE project_file_leases SET revoked_at = COALESCE(revoked_at, NOW()) WHERE conversation_id = $1', [conversationId])
      const leases = await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM project_file_leases WHERE conversation_id = $1 AND stopped_at IS NULL', [conversationId])
      pending = leases.rows[0].count
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  if (pending) fail('TASKS_STOPPING', 409, `${pending} project task(s) are stopping. Retry after they exit; the current project has not changed.`)
}

export async function attachGroupProject(companyId: string, userId: string, conversationId: string, projectId: string | null) {
  // Validate the destination before stopping work in the current project.
  const check = await pool.connect()
  try {
    await check.query('BEGIN')
    await check.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId])
    await requireProjectAdmin(check, companyId, userId)
    const { rows } = await check.query<{ project_id: string | null; kind: string; members: string[] }>(
      'SELECT project_id, kind, members FROM conversations WHERE id = $1 AND company_id = $2', [conversationId, companyId])
    if (!rows[0] || rows[0].kind !== 'group' || !rows[0].members.includes(userId)) fail('NOT_FOUND', 404, 'Group not found.')
    if (projectId !== null && projectId !== rows[0].project_id) await validateNewProjectBinding(check, companyId, userId, projectId, conversationId)
    if (projectId === rows[0].project_id) {
      // Explicitly selecting the current project cancels a failed switch only
      // after every old task stopped. Revoked leases remain revoked.
      const pending = await check.query('SELECT 1 FROM project_file_leases WHERE conversation_id = $1 AND stopped_at IS NULL LIMIT 1', [conversationId])
      if (pending.rows[0]) fail('TASKS_STOPPING', 409, 'Project tasks have not stopped yet.')
      if (projectId) await check.query('UPDATE projects SET file_switching = FALSE WHERE id = $1', [projectId])
      await check.query('COMMIT'); return { ok: true, projectId }
    }
    await check.query('COMMIT')
  } catch (error) { await check.query('ROLLBACK'); throw error } finally { check.release() }
  await prepareGroupProjectStop(companyId, userId, conversationId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId])
    await requireProjectAdmin(client, companyId, userId)
    const group = await client.query<{ project_id: string | null; members: string[] }>('SELECT project_id, members FROM conversations WHERE id = $1 AND company_id = $2 FOR UPDATE', [conversationId, companyId])
    if (!group.rows[0]?.members.includes(userId)) fail('NOT_FOUND', 404, 'Group not found.')
    if (projectId !== null) await validateNewProjectBinding(client, companyId, userId, projectId, conversationId)
    const pending = await client.query('SELECT 1 FROM project_file_leases WHERE conversation_id = $1 AND stopped_at IS NULL LIMIT 1', [conversationId])
    if (pending.rows[0]) fail('TASKS_STOPPING', 409, 'Project tasks have not stopped yet.')
    await client.query('UPDATE conversations SET project_id = $1, updated_at = NOW() WHERE id = $2', [projectId, conversationId])
    if (group.rows[0].project_id) await client.query('UPDATE projects SET file_switching = FALSE WHERE id = $1', [group.rows[0].project_id])
    await client.query('COMMIT')
    return { ok: true, projectId }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
