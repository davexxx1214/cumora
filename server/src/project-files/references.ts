import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW, publish } from '../redis.js'
import type { StoredAttachment } from '../storage.js'
import { fail, type ProjectFileReference } from './model.js'
import { projectFilesFor, projectLeaseScope, type ProjectFileIdentity } from './service.js'

export async function projectAttachment(identity: ProjectFileIdentity, conversationId: string, raw: unknown): Promise<StoredAttachment> {
  if (!raw || typeof raw !== 'object') fail('INVALID_REFERENCE', 400, 'Project file reference required.')
  const ref = raw as ProjectFileReference
  if (![ref.projectId, ref.entryId, ref.versionId].every(v => typeof v === 'string' && v.length < 100)) fail('INVALID_REFERENCE', 400, 'Invalid project file reference.')
  const group = await pool.query('SELECT 1 FROM conversations WHERE id = $1 AND project_id = $2', [conversationId, ref.projectId])
  if (!group.rows[0]) fail('BINDING_CHANGED', 409, 'This file does not belong to the current group project.')
  const file = await projectFilesFor(identity).read(ref.projectId, ref.entryId, ref.versionId)
  return { url: '', name: file.name, kind: 'file', size: file.content.length, mime: 'application/octet-stream',
    projectFile: { projectId: ref.projectId, entryId: ref.entryId, versionId: file.versionId, name: file.name } }
}

/** Share an existing file, without copying bytes to public attachment storage.
 * The path is resolved only inside the lease's explicit project. */
export async function shareAgentProjectFile(token: string, path: string, body: string) {
  const lease = await projectLeaseScope(token)
  const service = projectFilesFor({ kind: 'lease', token })
  const prefix = `/projects/${lease.project_id}/`
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path
  if (relative.startsWith('/') || relative.split('/').some(p => !p || p === '.' || p === '..')) fail('INVALID_PATH', 400, 'Name a file inside this project.')
  let parentId = 'root'
  let item
  for (const name of relative.split('/')) {
    item = (await service.list(lease.project_id, parentId)).entries.find(entry => entry.name === name)
    if (!item) fail('NOT_FOUND', 404, 'Project file not found.')
    parentId = item.id
  }
  if (!item || item.kind !== 'file' || !item.versionId) fail('NOT_FILE', 400, 'Select a regular project file.')
  const attachment = await projectAttachment({ kind: 'lease', token }, lease.conversation_id,
    { projectId: lease.project_id, entryId: item.id, versionId: item.versionId })
  await projectLeaseScope(token)
  const client = await pool.connect()
  const id = `m-${randomUUID()}`
  let sequence: number
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id = $1 FOR SHARE', [lease.company_id])
    const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND file_binding_version = $2 AND status = \'active\' AND NOT file_switching FOR SHARE', [lease.project_id, lease.binding_version])
    const group = await client.query('SELECT 1 FROM conversations WHERE id = $1 AND project_id = $2 AND members @> $3::jsonb FOR UPDATE', [lease.conversation_id, lease.project_id, JSON.stringify([lease.agent_id])])
    const active = await client.query('SELECT 1 FROM project_file_leases WHERE id = $1 AND revoked_at IS NULL AND stopped_at IS NULL AND expires_at > NOW() FOR SHARE', [lease.id])
    if (!project.rows[0] || !group.rows[0] || !active.rows[0]) fail('REVOKED', 403, 'Project task was revoked.')
    const counter = await client.query<{ seq: number }>(`INSERT INTO conversation_counters(conversation_id,next_sequence) VALUES ($1,2)
      ON CONFLICT(conversation_id) DO UPDATE SET next_sequence=conversation_counters.next_sequence+1 RETURNING next_sequence-1 AS seq`, [lease.conversation_id])
    sequence = counter.rows[0].seq
    await client.query(`INSERT INTO messages(id,conversation_id,author_id,kind,body,sequence,attachment,company_id)
      VALUES ($1,$2,$3,'text',$4,$5,$6::jsonb,$7)`, [id, lease.conversation_id, lease.agent_id, body.slice(0, 20_000), sequence, JSON.stringify(attachment), lease.company_id])
    await client.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1', [lease.conversation_id])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  await publish(CH_MESSAGE_NEW, { type: 'message.new', companyId: lease.company_id, conversationId: lease.conversation_id,
    message: { id, conversationId: lease.conversation_id, authorId: lease.agent_id, kind: 'text', body: body.slice(0, 20_000), sequence, attachment, at: new Date().toISOString() } }).catch(() => {})
  return { ok: true, exitCode: 0, text: `Shared ${attachment.name} in ${lease.conversation_id} (${id}).` }
}
