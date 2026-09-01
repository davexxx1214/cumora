import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { projectFilesFor } from '../project-files/service.js'
import {
  DEFECT_RESOLUTIONS,
  DEFECT_SEVERITIES,
  oneOf,
  type ProjectWorkflowRecord,
  type ProjectWorkItemRecord,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  WORKFLOW_STATUSES,
  type WorkItemStatus,
  workflowFail,
} from './model.js'

type Queryable = Pick<PoolClient, 'query'>

interface ScopeRow {
  conversation_id: string
  project_id: string | null
  project_name: string | null
  project_status: string | null
  role: string
  actor_name: string
  workflow_id: string | null
  issue_prefix: string | null
  next_number: number | null
  workflow_status: 'active' | 'closed' | null
  workflow_version: string | number | null
  workflow_created_by: string | null
  workflow_created_at: string | null
  workflow_updated_at: string | null
  workflow_closed_at: string | null
}

export interface HumanWorkflowScope {
  companyId: string
  userId: string
  actorName: string
  role: string
  admin: boolean
  conversationId: string
  projectId: string
  projectName: string
  projectStatus: string
  workflow: ProjectWorkflowRecord | null
}

interface WorkItemRow {
  id: string
  workflow_id: string
  project_id: string
  issue_number: number
  issue_key: string
  type: 'user_story' | 'defect' | 'subtask'
  parent_id: string | null
  title: string
  description: string
  status: WorkItemStatus
  priority: 'low' | 'medium' | 'high' | 'critical'
  assignee_id: string | null
  assignee_kind: 'human' | 'agent' | null
  reporter_id: string
  labels: unknown
  due_at: string | null
  rank: number
  version: string | number
  user_value: string | null
  acceptance_criteria: string | null
  story_points: number | null
  severity: 'low' | 'medium' | 'high' | 'critical' | null
  reproduction_steps: string | null
  expected_result: string | null
  actual_result: string | null
  environment: string | null
  resolution: 'fixed' | 'duplicate' | 'cannot_reproduce' | 'wont_fix' | null
  archived_at: string | null
  created_at: string
  updated_at: string
  subtask_done?: number
  subtask_total?: number
}

export interface WorkItemInput {
  type?: unknown
  parentId?: unknown
  title?: unknown
  description?: unknown
  status?: unknown
  priority?: unknown
  assigneeId?: unknown
  labels?: unknown
  dueAt?: unknown
  rank?: unknown
  userValue?: unknown
  acceptanceCriteria?: unknown
  storyPoints?: unknown
  severity?: unknown
  reproductionSteps?: unknown
  expectedResult?: unknown
  actualResult?: unknown
  environment?: unknown
  resolution?: unknown
}

export interface ItemMutationResult {
  item: ProjectWorkItemRecord
  notificationRecipientIds: string[]
  eventKind: 'item.created' | 'item.updated' | 'item.assigned' | 'item.status_changed' | 'item.force_completed'
  agentExecution?: AgentExecutionDispatch
}

export interface AgentExecutionDispatch {
  created: boolean
  command: { id: string; status: string; createdAt: string; agentId: string; messageId: string | null }
  message: { id: string; sequence: number; body: string; at: string; agentRecipientIds: string[] } | null
}

function workflowFromScope(row: ScopeRow, companyId: string): ProjectWorkflowRecord | null {
  if (!row.workflow_id || !row.project_id || !row.issue_prefix || !row.workflow_status) return null
  return {
    id: row.workflow_id,
    projectId: row.project_id,
    companyId,
    issuePrefix: row.issue_prefix,
    nextNumber: Number(row.next_number),
    status: row.workflow_status,
    version: Number(row.workflow_version),
    createdBy: row.workflow_created_by ?? '',
    createdAt: row.workflow_created_at ?? '',
    updatedAt: row.workflow_updated_at ?? '',
    closedAt: row.workflow_closed_at,
  }
}

export async function requireHumanWorkflowScope(
  db: Queryable,
  companyId: string,
  userId: string,
  conversationId: string,
  options: { workflow?: boolean; mutation?: boolean; admin?: boolean } = {},
): Promise<HumanWorkflowScope> {
  const { rows } = await db.query<ScopeRow>(
    `SELECT c.id AS conversation_id, c.project_id, p.name AS project_name,
            p.status AS project_status, cm.role, u.display_name AS actor_name,
            w.id AS workflow_id, w.issue_prefix, w.next_number,
            w.status AS workflow_status, w.version AS workflow_version,
            w.created_by AS workflow_created_by, w.created_at AS workflow_created_at,
            w.updated_at AS workflow_updated_at, w.closed_at AS workflow_closed_at
       FROM conversations c
       JOIN company_members cm ON cm.company_id = c.company_id AND cm.user_id = $3
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN projects p ON p.id = c.project_id AND p.company_id = c.company_id
       LEFT JOIN project_workflows w ON w.project_id = p.id AND w.company_id = c.company_id
      WHERE c.id = $1 AND c.company_id = $2 AND c.kind = 'group'
        AND c.members @> to_jsonb(ARRAY[$3::text])
      LIMIT 1`,
    [conversationId, companyId, userId],
  )
  const row = rows[0]
  if (!row) workflowFail('NOT_FOUND', 404, 'Group not found.')
  if (!row.project_id || !row.project_name || !row.project_status) {
    workflowFail('PROJECT_REQUIRED', 409, 'Mount a project before using project workflow.')
  }
  const scope: HumanWorkflowScope = {
    companyId, userId, actorName: row.actor_name, role: row.role,
    admin: row.role === 'owner' || row.role === 'admin',
    conversationId: row.conversation_id, projectId: row.project_id,
    projectName: row.project_name, projectStatus: row.project_status,
    workflow: workflowFromScope(row, companyId),
  }
  if (options.admin && !scope.admin) workflowFail('ADMIN_REQUIRED', 403, 'A workspace administrator is required.')
  if (options.workflow && !scope.workflow) workflowFail('WORKFLOW_DISABLED', 409, 'Project workflow is not enabled.')
  if (options.mutation) {
    if (scope.projectStatus !== 'active') workflowFail('PROJECT_UNAVAILABLE', 409, 'The project is archived.')
    if (scope.workflow?.status === 'closed') workflowFail('WORKFLOW_CLOSED', 409, 'Project workflow is closed.')
  }
  return scope
}

function prefixFor(projectName: string, requested: unknown): string {
  const raw = typeof requested === 'string' && requested.trim() ? requested : projectName
  const normalized = raw.normalize('NFKD').replace(/[^A-Za-z0-9]/gu, '').toUpperCase().slice(0, 10)
  if (normalized.length >= 2) return normalized
  const fallback = `PRJ${projectName.length}`.replace(/[^A-Z0-9]/gu, '').slice(0, 10)
  return fallback.length >= 2 ? fallback : 'PRJ'
}

function workItemFromRow(row: WorkItemRow): ProjectWorkItemRecord {
  return {
    id: row.id, workflowId: row.workflow_id, projectId: row.project_id,
    issueNumber: Number(row.issue_number), issueKey: row.issue_key, type: row.type,
    parentId: row.parent_id, title: row.title, description: row.description,
    status: row.status, priority: row.priority, assigneeId: row.assignee_id,
    assigneeKind: row.assignee_kind, reporterId: row.reporter_id,
    labels: Array.isArray(row.labels) ? row.labels.filter((x): x is string => typeof x === 'string') : [],
    dueAt: row.due_at, rank: Number(row.rank), version: Number(row.version),
    userValue: row.user_value, acceptanceCriteria: row.acceptance_criteria,
    storyPoints: row.story_points == null ? null : Number(row.story_points), severity: row.severity,
    reproductionSteps: row.reproduction_steps, expectedResult: row.expected_result,
    actualResult: row.actual_result, environment: row.environment, resolution: row.resolution,
    archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
    subtaskDone: Number(row.subtask_done ?? 0), subtaskTotal: Number(row.subtask_total ?? 0),
  }
}

const ITEM_SELECT = `i.id, i.workflow_id, i.project_id, i.issue_number, i.issue_key,
  i.type, i.parent_id, i.title, i.description, i.status, i.priority,
  i.assignee_id, i.assignee_kind, i.reporter_id, i.labels, i.due_at, i.rank,
  i.version, i.user_value, i.acceptance_criteria, i.story_points, i.severity,
  i.reproduction_steps, i.expected_result, i.actual_result, i.environment,
  i.resolution, i.archived_at, i.created_at, i.updated_at,
  (SELECT COUNT(*)::int FROM project_work_items s WHERE s.parent_id = i.id AND s.archived_at IS NULL) AS subtask_total,
  (SELECT COUNT(*)::int FROM project_work_items s WHERE s.parent_id = i.id AND s.archived_at IS NULL AND s.status IN ('done','canceled')) AS subtask_done`

async function fetchItem(db: Queryable, workflowId: string, itemId: string, lock = false): Promise<ProjectWorkItemRecord> {
  const { rows } = await db.query<WorkItemRow>(
    `SELECT ${ITEM_SELECT} FROM project_work_items i
      WHERE i.id = $1 AND i.workflow_id = $2${lock ? ' FOR UPDATE OF i' : ''}`,
    [itemId, workflowId],
  )
  if (!rows[0]) workflowFail('NOT_FOUND', 404, 'Work item not found.')
  return workItemFromRow(rows[0])
}

async function addEvent(db: Queryable, args: {
  workflowId: string; itemId?: string | null; actorId: string; actorKind?: 'human' | 'agent' | 'system'
  actorName: string; type: string; changes?: Record<string, unknown>; source?: 'web' | 'agent' | 'system'; reason?: string | null
}): Promise<void> {
  await db.query(
    `INSERT INTO project_work_item_events
       (id, workflow_id, item_id, actor_id, actor_kind, actor_name, event_type, changes, source, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [`wie-${randomUUID()}`, args.workflowId, args.itemId ?? null, args.actorId,
      args.actorKind ?? 'human', args.actorName, args.type, JSON.stringify(args.changes ?? {}),
      args.source ?? 'web', args.reason ?? null],
  )
}

async function cancelActiveAgentCommands(db: Queryable, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return
  const { rows } = await db.query<{ message_id: string | null; run_id: string | null }>(
    `UPDATE project_work_item_agent_commands SET status='canceled',updated_at=NOW()
      WHERE item_id=ANY($1::text[]) AND status IN ('pending','running') RETURNING message_id,run_id`, [itemIds],
  )
  const runIds = rows.map(row => row.run_id).filter((id): id is string => Boolean(id))
  if (runIds.length) {
    // Reassignment/closure must revoke the current task namespace immediately.
    // The daemon may take a moment to stop its process tree, but all subsequent
    // file and workflow mutations fail as soon as revoked_at is committed.
    await db.query(
      `UPDATE project_file_leases SET revoked_at=COALESCE(revoked_at,NOW())
        WHERE run_id=ANY($1::text[]) AND stopped_at IS NULL`,
      [runIds],
    )
  }
  const messageIds = rows.map(row => row.message_id).filter((id): id is string => Boolean(id))
  if (messageIds.length) {
    await db.query(
      `UPDATE messages SET agent_recipient_ids='[]'::jsonb,
          body=CASE WHEN body LIKE '[已取消]%' THEN body ELSE '[已取消，不要执行]\n' || body END
        WHERE id=ANY($1::text[])`, [messageIds],
    )
  }
}

async function addNotification(db: Queryable, scope: HumanWorkflowScope, args: {
  itemId: string; recipientId: string | null; kind: 'assigned' | 'reassigned' | 'blocked' | 'mentioned' | 'agent_execute'; dedupeKey: string
}): Promise<boolean> {
  if (!args.recipientId || args.recipientId === scope.userId || !scope.workflow) return false
  const result = await db.query(
    `INSERT INTO project_workflow_notifications
       (id, company_id, project_id, conversation_id, workflow_id, item_id, recipient_id, actor_id, kind, dedupe_key)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id=$4 AND c.project_id=$3 AND c.members @> to_jsonb(ARRAY[$7::text]))
     ON CONFLICT (recipient_id, dedupe_key) DO NOTHING`,
    [`pwn-${randomUUID()}`, scope.companyId, scope.projectId, scope.conversationId,
      scope.workflow.id, args.itemId, args.recipientId, scope.userId, args.kind, args.dedupeKey],
  )
  return Boolean(result.rowCount)
}

async function validateAssignee(db: Queryable, scope: HumanWorkflowScope, assigneeId: unknown): Promise<{ id: string; kind: 'human' | 'agent' } | null> {
  if (assigneeId == null || assigneeId === '') return null
  if (typeof assigneeId !== 'string') workflowFail('INVALID_ASSIGNEE', 400, 'assigneeId must be a participant id or null.')
  const { rows } = await db.query<{ id: string; kind: 'human' | 'agent' }>(
    `SELECT p.id, p.kind FROM participants p
       JOIN conversations c ON c.id=$3 AND c.company_id=p.company_id
      WHERE p.id=$1 AND p.company_id=$2 AND p.departed_at IS NULL
        AND p.kind IN ('human','agent') AND c.project_id=$4
        AND c.members @> to_jsonb(ARRAY[p.id::text]) LIMIT 1`,
    [assigneeId, scope.companyId, scope.conversationId, scope.projectId],
  )
  if (!rows[0]) workflowFail('INVALID_ASSIGNEE', 400, 'Assignee must be an active member of the current project group.')
  return rows[0]
}

function cleanText(value: unknown, max: number, nullable = false): string | null {
  if (value == null) return nullable ? null : ''
  const text = String(value).trim().slice(0, max)
  return nullable && !text ? null : text
}

function cleanLabels(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) workflowFail('INVALID_LABELS', 400, 'labels must be an array.')
  const labels = [...new Set(value.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))]
  if (labels.length > 20 || labels.some(x => x.length > 40)) workflowFail('INVALID_LABELS', 400, 'Use at most 20 labels of 40 characters each.')
  return labels
}

function cleanDate(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) workflowFail('INVALID_DATE', 400, 'dueAt must be a valid date.')
  return new Date(value).toISOString()
}

export async function getWorkflow(companyId: string, userId: string, conversationId: string) {
  const scope = await requireHumanWorkflowScope(pool, companyId, userId, conversationId)
  return {
    project: { id: scope.projectId, name: scope.projectName, status: scope.projectStatus },
    conversationId: scope.conversationId, role: scope.role, canManage: scope.admin,
    workflow: scope.workflow,
  }
}

export async function createWorkflow(companyId: string, userId: string, conversationId: string, requestedPrefix?: unknown) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { admin: true })
    await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [scope.projectId])
    if (scope.workflow) workflowFail('WORKFLOW_EXISTS', 409, 'This project already has a workflow.')
    const id = `pw-${randomUUID()}`
    const prefix = prefixFor(scope.projectName, requestedPrefix)
    const { rows } = await client.query<{
      id: string; project_id: string; company_id: string; issue_prefix: string; next_number: number
      status: 'active'; version: string | number; created_by: string; created_at: string; updated_at: string; closed_at: null
    }>(`INSERT INTO project_workflows(id,project_id,company_id,issue_prefix,created_by)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,project_id,company_id,issue_prefix,next_number,status,version,created_by,created_at,updated_at,closed_at`,
    [id, scope.projectId, companyId, prefix, userId])
    await addEvent(client, { workflowId: id, actorId: userId, actorName: scope.actorName,
      type: 'workflow.created', changes: { issuePrefix: prefix } })
    await client.query('COMMIT')
    const row = rows[0]
    return {
      scope: { ...scope, workflow: null }, workflow: {
        id: row.id, projectId: row.project_id, companyId: row.company_id,
        issuePrefix: row.issue_prefix, nextNumber: Number(row.next_number), status: row.status,
        version: Number(row.version), createdBy: row.created_by, createdAt: row.created_at,
        updatedAt: row.updated_at, closedAt: row.closed_at,
      } satisfies ProjectWorkflowRecord,
    }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function setWorkflowClosed(companyId: string, userId: string, conversationId: string, closed: boolean) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { admin: true, workflow: true })
    const nextStatus = closed ? 'closed' : 'active'
    await client.query(`UPDATE project_workflows SET status=$1, closed_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
      closed_by=CASE WHEN $2 THEN $3 ELSE NULL END, version=version+1, updated_at=NOW() WHERE id=$4`,
    [nextStatus, closed, userId, scope.workflow!.id])
    await addEvent(client, { workflowId: scope.workflow!.id, actorId: userId, actorName: scope.actorName,
      type: closed ? 'workflow.closed' : 'workflow.reopened', changes: { status: { from: scope.workflow!.status, to: nextStatus } } })
    if (closed) {
      const active = await client.query<{ id: string }>('SELECT id FROM project_work_items WHERE workflow_id=$1', [scope.workflow!.id])
      await cancelActiveAgentCommands(client, active.rows.map(row => row.id))
    }
    await client.query('COMMIT')
    return { scope, workflowId: scope.workflow!.id, status: nextStatus as 'active' | 'closed' }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export interface WorkItemFilters {
  types?: string[]; statuses?: string[]; priorities?: string[]; assigneeId?: string
  label?: string; search?: string; archived?: boolean; parentId?: string | null
  limit?: number; offset?: number
}

export async function listWorkItems(companyId: string, userId: string, conversationId: string, filters: WorkItemFilters = {}) {
  const scope = await requireHumanWorkflowScope(pool, companyId, userId, conversationId, { workflow: true })
  const values: unknown[] = [scope.workflow!.id]
  const where = ['i.workflow_id = $1']
  const addArray = (column: string, valuesIn: string[] | undefined, allowed: readonly string[]) => {
    const valid = valuesIn?.filter(value => allowed.includes(value)) ?? []
    if (valid.length) { values.push(valid); where.push(`${column} = ANY($${values.length}::text[])`) }
  }
  addArray('i.type', filters.types, WORK_ITEM_TYPES)
  addArray('i.status', filters.statuses, WORKFLOW_STATUSES)
  addArray('i.priority', filters.priorities, WORK_ITEM_PRIORITIES)
  if (filters.assigneeId) { values.push(filters.assigneeId); where.push(`i.assignee_id = $${values.length}`) }
  if (filters.label) { values.push(filters.label); where.push(`i.labels @> to_jsonb(ARRAY[$${values.length}::text])`) }
  if (filters.search) { values.push(`%${filters.search.slice(0, 120)}%`); where.push(`(i.title ILIKE $${values.length} OR i.issue_key ILIKE $${values.length})`) }
  if (filters.parentId !== undefined) {
    if (filters.parentId === null) where.push('i.parent_id IS NULL')
    else { values.push(filters.parentId); where.push(`i.parent_id = $${values.length}`) }
  }
  where.push(filters.archived
    ? 'i.archived_at IS NOT NULL'
    : `i.archived_at IS NULL AND (i.parent_id IS NULL OR EXISTS (
        SELECT 1 FROM project_work_items visible_parent
         WHERE visible_parent.id=i.parent_id AND visible_parent.archived_at IS NULL))`)
  const limit = Math.max(1, Math.min(200, filters.limit ?? 100))
  const offset = Math.max(0, filters.offset ?? 0)
  values.push(limit, offset)
  const { rows } = await pool.query<WorkItemRow>(
    `SELECT ${ITEM_SELECT} FROM project_work_items i WHERE ${where.join(' AND ')}
      ORDER BY CASE i.status WHEN 'todo' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'blocked' THEN 3
                    WHEN 'in_review' THEN 4 WHEN 'done' THEN 5 ELSE 6 END,
               i.rank ASC, i.created_at ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )
  return { workflow: scope.workflow, projectId: scope.projectId, conversationId, items: rows.map(workItemFromRow), limit, offset }
}

export async function getWorkItem(companyId: string, userId: string, conversationId: string, itemId: string) {
  const scope = await requireHumanWorkflowScope(pool, companyId, userId, conversationId, { workflow: true })
  return { scope, item: await fetchItem(pool, scope.workflow!.id, itemId) }
}

/**
 * Create the durable execution command and its targeted group @message inside
 * the caller's transaction. Assignment calls this automatically; the manual
 * execute endpoint uses the same primitive for retries or added instructions.
 */
async function queueAgentExecution(
  db: Queryable,
  scope: HumanWorkflowScope,
  item: ProjectWorkItemRecord,
  idempotencyKey: string,
  instruction: unknown,
  source: 'assignment' | 'manual',
): Promise<AgentExecutionDispatch> {
  if (!item.assigneeId || item.assigneeKind !== 'agent') workflowFail('AGENT_ASSIGNEE_REQUIRED', 409, 'Assign this item to an Agent first.')
  await validateAssignee(db, scope, item.assigneeId)
  const cleanedInstruction = cleanText(instruction, 8000)
  if (source === 'manual') {
    const exact = await db.query<{ id: string }>(
      'SELECT id FROM project_work_item_agent_commands WHERE item_id=$1 AND idempotency_key=$2',
      [item.id, idempotencyKey],
    )
    if (!exact.rows[0]) {
      const active = await db.query<{ id: string }>(
        `SELECT id FROM project_work_item_agent_commands
          WHERE item_id=$1 AND agent_id=$2 AND status IN ('pending','running')
          ORDER BY created_at DESC LIMIT 1`,
        [item.id, item.assigneeId],
      )
      if (active.rows[0]) workflowFail('AGENT_EXECUTION_ACTIVE', 409, 'This Agent already has an active execution for the item.')
    }
  }
  const commandId = `wicmd-${randomUUID()}`
  const { rows } = await db.query<{ id: string; status: string; created_at: string; message_id: string | null; agent_id: string }>(
    `INSERT INTO project_work_item_agent_commands
       (id,item_id,project_id,conversation_id,agent_id,requested_by,idempotency_key,instruction)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(item_id,idempotency_key) DO NOTHING
     RETURNING id,status,created_at,message_id,agent_id`,
    [commandId, item.id, scope.projectId, scope.conversationId, item.assigneeId, scope.userId, idempotencyKey, cleanedInstruction],
  )
  const created = Boolean(rows[0])
  const command = rows[0] ?? (await db.query<{ id: string; status: string; created_at: string; message_id: string | null; agent_id: string }>(
    `SELECT id,status,created_at,message_id,agent_id FROM project_work_item_agent_commands
      WHERE item_id=$1 AND idempotency_key=$2`, [item.id, idempotencyKey],
  )).rows[0]
  if (!command) throw new Error('agent command insert returned no row')

  let message: AgentExecutionDispatch['message'] = null
  if (created) {
    const seq = await db.query<{ seq: number }>(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 2)
       ON CONFLICT (conversation_id) DO UPDATE SET next_sequence=conversation_counters.next_sequence+1
       RETURNING next_sequence-1 AS seq`, [scope.conversationId],
    )
    const sequence = Number(seq.rows[0]?.seq ?? 1)
    const messageId = `m-${randomUUID()}`
    const body = [
      source === 'assignment'
        ? `@${item.assigneeId} 你已被分配项目流程事项 ${item.issueKey}：${item.title}，请开始执行。`
        : `@${item.assigneeId} 请执行项目流程事项 ${item.issueKey}：${item.title}`,
      cleanedInstruction || '请按事项描述和验收标准执行。',
      `先运行 \`cumora workflow show ${item.issueKey}\` 获取受控详情；开始时更新为 in_progress，完成后更新为 in_review，不要自行标记 done。`,
    ].join('\n')
    const at = new Date().toISOString()
    await db.query(
      `INSERT INTO messages
        (id,conversation_id,author_id,kind,body,sequence,company_id,client_id,agent_recipient_ids)
       VALUES($1,$2,$3,'text',$4,$5,$6,$7,$8::jsonb)`,
      [messageId, scope.conversationId, scope.userId, body, sequence, scope.companyId,
        `workflow-command:${command.id}`, JSON.stringify([item.assigneeId])],
    )
    await db.query('UPDATE project_work_item_agent_commands SET message_id=$2,updated_at=NOW() WHERE id=$1', [command.id, messageId])
    await db.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1', [scope.conversationId])
    command.message_id = messageId
    message = { id: messageId, sequence, body, at, agentRecipientIds: [item.assigneeId] }
    await addEvent(db, { workflowId: scope.workflow!.id, itemId: item.id, actorId: scope.userId, actorName: scope.actorName,
      type: 'agent.execution_requested', changes: { commandId: command.id, agentId: item.assigneeId, messageId, source } })
    await addNotification(db, scope, { itemId: item.id, recipientId: item.assigneeId, kind: 'agent_execute',
      dedupeKey: `${item.id}:execute:${idempotencyKey}` })
  }
  return { created, message,
    command: { id: command.id, status: command.status, createdAt: command.created_at,
      agentId: command.agent_id, messageId: command.message_id } }
}

export async function createWorkItem(companyId: string, userId: string, conversationId: string, input: WorkItemInput): Promise<{ scope: HumanWorkflowScope } & ItemMutationResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    const workflowId = scope.workflow!.id
    const type = input.type
    if (!oneOf(type, WORK_ITEM_TYPES)) workflowFail('INVALID_TYPE', 400, 'type must be user_story, defect, or subtask.')
    const title = cleanText(input.title, 240)
    if (!title) workflowFail('TITLE_REQUIRED', 400, 'title required.')
    const parentId = type === 'subtask' && typeof input.parentId === 'string' ? input.parentId : null
    if (type === 'subtask' && !parentId) workflowFail('PARENT_REQUIRED', 400, 'A subtask requires a parent User Story or Defect.')
    if (type !== 'subtask' && input.parentId != null) workflowFail('INVALID_PARENT', 400, 'Only a subtask can have a parent.')
    if (parentId) {
      const parent = await fetchItem(client, workflowId, parentId, true)
      if (parent.type === 'subtask' || parent.archivedAt) workflowFail('INVALID_PARENT', 400, 'Subtasks can only belong to an active User Story or Defect.')
    }
    const status = input.status == null ? 'todo' : input.status
    const priority = input.priority == null ? 'medium' : input.priority
    if (!oneOf(status, WORKFLOW_STATUSES)) workflowFail('INVALID_STATUS', 400, 'Invalid status.')
    if (!oneOf(priority, WORK_ITEM_PRIORITIES)) workflowFail('INVALID_PRIORITY', 400, 'Invalid priority.')
    const assignee = await validateAssignee(client, scope, input.assigneeId)
    const labels = cleanLabels(input.labels)
    const dueAt = cleanDate(input.dueAt)
    let storyPoints: number | null = null
    if (input.storyPoints != null && input.storyPoints !== '') {
      storyPoints = Number(input.storyPoints)
      if (!Number.isInteger(storyPoints) || storyPoints < 0 || storyPoints > 100) workflowFail('INVALID_STORY_POINTS', 400, 'storyPoints must be an integer from 0 to 100.')
    }
    const severity = input.severity == null || input.severity === '' ? null : input.severity
    if (severity !== null && !oneOf(severity, DEFECT_SEVERITIES)) workflowFail('INVALID_SEVERITY', 400, 'Invalid defect severity.')
    const resolution = input.resolution == null || input.resolution === '' ? null : input.resolution
    if (resolution !== null && (!oneOf(resolution, DEFECT_RESOLUTIONS) || type !== 'defect' || !['done','canceled'].includes(status))) {
      workflowFail('INVALID_RESOLUTION', 400, 'A resolution is only valid for a completed or canceled Defect.')
    }
    const { rows: numbers } = await client.query<{ issue_number: number; issue_prefix: string }>(
      `UPDATE project_workflows SET next_number=next_number+1, updated_at=NOW(), version=version+1
        WHERE id=$1 AND status='active' RETURNING next_number-1 AS issue_number, issue_prefix`, [workflowId])
    if (!numbers[0]) workflowFail('WORKFLOW_CLOSED', 409, 'Project workflow is closed.')
    const issueNumber = Number(numbers[0].issue_number)
    const issueKey = `${numbers[0].issue_prefix}-${issueNumber}`
    let rank = typeof input.rank === 'number' && Number.isFinite(input.rank) ? input.rank : null
    if (rank === null) {
      const { rows } = await client.query<{ max: number | null }>(
        `SELECT MAX(rank) AS max FROM project_work_items
          WHERE workflow_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND status=$3`, [workflowId, parentId, status])
      rank = Number(rows[0]?.max ?? 0) + 1000
    }
    const id = `wi-${randomUUID()}`
    await client.query(
      `INSERT INTO project_work_items
       (id,workflow_id,project_id,issue_number,issue_key,type,parent_id,title,description,status,priority,
        assignee_id,assignee_kind,reporter_id,labels,due_at,rank,user_value,acceptance_criteria,story_points,
        severity,reproduction_steps,expected_result,actual_result,environment,resolution)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [id, workflowId, scope.projectId, issueNumber, issueKey, type, parentId, title,
        cleanText(input.description, 30_000), status, priority, assignee?.id ?? null, assignee?.kind ?? null,
        userId, JSON.stringify(labels), dueAt, rank,
        type === 'user_story' ? cleanText(input.userValue, 8_000, true) : null,
        type === 'user_story' ? cleanText(input.acceptanceCriteria, 16_000, true) : null,
        type === 'user_story' ? storyPoints : null,
        type === 'defect' ? severity : null,
        type === 'defect' ? cleanText(input.reproductionSteps, 16_000, true) : null,
        type === 'defect' ? cleanText(input.expectedResult, 8_000, true) : null,
        type === 'defect' ? cleanText(input.actualResult, 8_000, true) : null,
        type === 'defect' ? cleanText(input.environment, 8_000, true) : null,
        type === 'defect' ? resolution : null],
    )
    await addEvent(client, { workflowId, itemId: id, actorId: userId, actorName: scope.actorName,
      type: 'item.created', changes: { issueKey, type, title, assigneeId: assignee?.id ?? null } })
    const notificationRecipientIds: string[] = []
    if (assignee && await addNotification(client, scope, { itemId: id, recipientId: assignee.id,
      kind: 'assigned', dedupeKey: `${id}:assigned:${assignee.id}:1` })) notificationRecipientIds.push(assignee.id)
    const item = await fetchItem(client, workflowId, id)
    const agentExecution = assignee?.kind === 'agent' && !['done','canceled'].includes(item.status)
      ? await queueAgentExecution(client, scope, item, `assignment:${id}:v${item.version}:${assignee.id}`,
        '你已被分配此事项，请按事项描述和验收标准开始执行。', 'assignment')
      : undefined
    await client.query('COMMIT')
    return { scope, item, notificationRecipientIds, eventKind: 'item.created', agentExecution }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

function different(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

export async function updateWorkItem(companyId: string, userId: string, conversationId: string, itemId: string,
  expectedVersion: unknown, input: WorkItemInput, forceReason?: unknown): Promise<{ scope: HumanWorkflowScope } & ItemMutationResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    const current = await fetchItem(client, scope.workflow!.id, itemId, true)
    const expected = Number(expectedVersion)
    if (!Number.isSafeInteger(expected) || expected !== current.version) {
      workflowFail('VERSION_CONFLICT', 409, 'Work item changed. Refresh and retry.', { current })
    }
    const sets: string[] = []
    const values: unknown[] = []
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const put = (column: string, field: keyof ProjectWorkItemRecord, next: unknown, cast = '', sqlValue = next) => {
      if (!different(current[field], next)) return
      values.push(sqlValue); sets.push(`${column}=$${values.length}${cast}`)
      changes[String(field)] = { from: current[field], to: next }
    }
    if (input.title !== undefined) {
      const next = cleanText(input.title, 240)
      if (!next) workflowFail('TITLE_REQUIRED', 400, 'title required.')
      put('title', 'title', next)
    }
    if (input.description !== undefined) put('description', 'description', cleanText(input.description, 30_000))
    if (input.priority !== undefined) {
      if (!oneOf(input.priority, WORK_ITEM_PRIORITIES)) workflowFail('INVALID_PRIORITY', 400, 'Invalid priority.')
      put('priority', 'priority', input.priority)
    }
    if (input.labels !== undefined) {
      const next = cleanLabels(input.labels)
      put('labels', 'labels', next, '::jsonb', JSON.stringify(next))
    }
    if (input.dueAt !== undefined) put('due_at', 'dueAt', cleanDate(input.dueAt))
    if (input.rank !== undefined) {
      if (typeof input.rank !== 'number' || !Number.isFinite(input.rank)) workflowFail('INVALID_RANK', 400, 'rank must be a finite number.')
      put('rank', 'rank', input.rank)
    }
    let assigneeChanged = false
    if (input.assigneeId !== undefined) {
      const next = await validateAssignee(client, scope, input.assigneeId)
      if (current.assigneeId !== (next?.id ?? null)) {
        put('assignee_id', 'assigneeId', next?.id ?? null)
        put('assignee_kind', 'assigneeKind', next?.kind ?? null)
        assigneeChanged = true
      }
    }
    let statusChanged = false
    let forced = false
    if (input.status !== undefined) {
      if (!oneOf(input.status, WORKFLOW_STATUSES)) workflowFail('INVALID_STATUS', 400, 'Invalid status.')
      if (input.status === 'done' && current.type !== 'subtask') {
        const { rows } = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM project_work_items WHERE parent_id=$1 AND archived_at IS NULL AND status NOT IN ('done','canceled')`, [itemId])
        if (Number(rows[0]?.count) > 0) {
          const reason = cleanText(forceReason, 2000, true)
          if (!scope.admin || !reason) workflowFail('SUBTASKS_INCOMPLETE', 409, 'Complete or cancel every Subtask before completing the parent. An administrator may force completion with a reason.', { incompleteCount: Number(rows[0].count) })
          forced = true
        }
      }
      if (current.status !== input.status) { put('status', 'status', input.status); statusChanged = true }
    }
    if (input.resolution !== undefined) {
      const next = input.resolution == null || input.resolution === '' ? null : input.resolution
      const resultingStatus = input.status && oneOf(input.status, WORKFLOW_STATUSES) ? input.status : current.status
      if (next !== null && (!oneOf(next, DEFECT_RESOLUTIONS) || current.type !== 'defect' || !['done','canceled'].includes(resultingStatus))) {
        workflowFail('INVALID_RESOLUTION', 400, 'A resolution is only valid for a completed or canceled Defect.')
      }
      put('resolution', 'resolution', next)
    } else if (statusChanged && input.status && !['done','canceled'].includes(input.status) && current.resolution) {
      put('resolution', 'resolution', null)
    }
    if (current.type === 'user_story') {
      if (input.userValue !== undefined) put('user_value', 'userValue', cleanText(input.userValue, 8_000, true))
      if (input.acceptanceCriteria !== undefined) put('acceptance_criteria', 'acceptanceCriteria', cleanText(input.acceptanceCriteria, 16_000, true))
      if (input.storyPoints !== undefined) {
        const next = input.storyPoints == null || input.storyPoints === '' ? null : Number(input.storyPoints)
        if (next !== null && (!Number.isInteger(next) || next < 0 || next > 100)) workflowFail('INVALID_STORY_POINTS', 400, 'storyPoints must be an integer from 0 to 100.')
        put('story_points', 'storyPoints', next)
      }
    }
    if (current.type === 'defect') {
      if (input.severity !== undefined) {
        const next = input.severity == null || input.severity === '' ? null : input.severity
        if (next !== null && !oneOf(next, DEFECT_SEVERITIES)) workflowFail('INVALID_SEVERITY', 400, 'Invalid defect severity.')
        put('severity', 'severity', next)
      }
      const defectText: Array<[keyof WorkItemInput, string, keyof ProjectWorkItemRecord, number]> = [
        ['reproductionSteps','reproduction_steps','reproductionSteps',16_000], ['expectedResult','expected_result','expectedResult',8_000],
        ['actualResult','actual_result','actualResult',8_000], ['environment','environment','environment',8_000],
      ]
      for (const [inputKey, column, field, max] of defectText) if (input[inputKey] !== undefined) put(column, field, cleanText(input[inputKey], max, true))
    }
    if (sets.length === 0) {
      await client.query('COMMIT')
      return { scope, item: current, notificationRecipientIds: [], eventKind: 'item.updated' }
    }
    values.push(itemId, scope.workflow!.id, expected)
    const { rowCount } = await client.query(
      `UPDATE project_work_items SET ${sets.join(',')}, version=version+1, updated_at=NOW()
        WHERE id=$${values.length - 2} AND workflow_id=$${values.length - 1} AND version=$${values.length}`,
      values,
    )
    if (!rowCount) workflowFail('VERSION_CONFLICT', 409, 'Work item changed. Refresh and retry.')
    const next = await fetchItem(client, scope.workflow!.id, itemId)
    if (assigneeChanged || (statusChanged && (next.status === 'done' || next.status === 'canceled'))) {
      await cancelActiveAgentCommands(client, [itemId])
    }
    const eventKind = forced ? 'item.force_completed' : assigneeChanged ? 'item.assigned' : statusChanged ? 'item.status_changed' : 'item.updated'
    await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: eventKind, changes, reason: forced ? cleanText(forceReason, 2000, true) : null })
    const notificationRecipientIds: string[] = []
    if (assigneeChanged && next.assigneeId && await addNotification(client, scope, { itemId, recipientId: next.assigneeId,
      kind: current.assigneeId ? 'reassigned' : 'assigned', dedupeKey: `${itemId}:assigned:${next.assigneeId}:v${next.version}` })) notificationRecipientIds.push(next.assigneeId)
    if (statusChanged && next.status === 'blocked') {
      for (const recipientId of [...new Set([next.assigneeId, next.reporterId])]) {
        if (await addNotification(client, scope, { itemId, recipientId, kind: 'blocked', dedupeKey: `${itemId}:blocked:v${next.version}:${recipientId}` })) notificationRecipientIds.push(recipientId!)
      }
    }
    const agentExecution = assigneeChanged && next.assigneeId && next.assigneeKind === 'agent'
      && !['done','canceled'].includes(next.status)
      ? await queueAgentExecution(client, scope, next, `assignment:${itemId}:v${next.version}:${next.assigneeId}`,
        '你已被分配此事项，请按事项描述和验收标准开始执行。', 'assignment')
      : undefined
    await client.query('COMMIT')
    return { scope, item: next, notificationRecipientIds: [...new Set(notificationRecipientIds)], eventKind, agentExecution }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function setWorkItemArchived(companyId: string, userId: string, conversationId: string, itemId: string,
  expectedVersion: unknown, archived: boolean) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    const current = await fetchItem(client, scope.workflow!.id, itemId, true)
    if (Number(expectedVersion) !== current.version) workflowFail('VERSION_CONFLICT', 409, 'Work item changed. Refresh and retry.', { current })
    await client.query(`UPDATE project_work_items SET archived_at=CASE WHEN $1 THEN NOW() ELSE NULL END,
      archived_by=CASE WHEN $1 THEN $2 ELSE NULL END, version=version+1, updated_at=NOW() WHERE id=$3`, [archived, userId, itemId])
    await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: archived ? 'item.archived' : 'item.restored', changes: { archived } })
    if (archived) await cancelActiveAgentCommands(client, [itemId])
    const item = await fetchItem(client, scope.workflow!.id, itemId)
    await client.query('COMMIT')
    return { scope, item, eventKind: archived ? 'item.archived' as const : 'item.restored' as const }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function deleteWorkItem(companyId: string, userId: string, conversationId: string, itemId: string, reason: unknown) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true, admin: true })
    const item = await fetchItem(client, scope.workflow!.id, itemId, true)
    const why = cleanText(reason, 2000, true)
    if (!why) workflowFail('REASON_REQUIRED', 400, 'A reason is required for permanent deletion.')
    const affected = await client.query<{ id: string }>(
      'SELECT id FROM project_work_items WHERE workflow_id=$1 AND (id=$2 OR parent_id=$2)',
      [scope.workflow!.id, itemId],
    )
    await cancelActiveAgentCommands(client, affected.rows.map(row => row.id))
    await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: 'item.deleted', changes: { issueKey: item.issueKey, title: item.title, type: item.type }, reason: why })
    await client.query('DELETE FROM project_work_items WHERE id=$1 AND workflow_id=$2', [itemId, scope.workflow!.id])
    await client.query('COMMIT')
    return { scope, itemId }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

async function parseMentions(db: Queryable, scope: HumanWorkflowScope, body: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT p.id,p.name FROM participants p JOIN conversations c ON c.id=$2 AND c.company_id=p.company_id
      WHERE p.company_id=$1 AND p.departed_at IS NULL AND c.project_id=$3
        AND c.members @> to_jsonb(ARRAY[p.id::text])`, [scope.companyId, scope.conversationId, scope.projectId])
  const lower = body.toLowerCase()
  return rows.filter(row => lower.includes(`@${row.id.toLowerCase()}`) || lower.includes(`@${row.name.toLowerCase()}`)).map(row => row.id)
}

export async function listComments(companyId: string, userId: string, conversationId: string, itemId: string) {
  const { scope } = await getWorkItem(companyId, userId, conversationId, itemId)
  const { rows } = await pool.query(
    `SELECT id,author_id AS "authorId",author_kind AS "authorKind",body,mentions,
            created_at AS "createdAt",updated_at AS "updatedAt",deleted_at AS "deletedAt"
       FROM project_work_item_comments WHERE item_id=$1 ORDER BY created_at`, [itemId])
  return { scope, comments: rows }
}

export async function addComment(companyId: string, userId: string, conversationId: string, itemId: string, rawBody: unknown) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    await fetchItem(client, scope.workflow!.id, itemId, true)
    const body = cleanText(rawBody, 12_000)
    if (!body) workflowFail('BODY_REQUIRED', 400, 'Comment body required.')
    const mentions = await parseMentions(client, scope, body)
    const id = `wic-${randomUUID()}`
    const { rows } = await client.query(`INSERT INTO project_work_item_comments(id,item_id,author_id,author_kind,body,mentions)
      VALUES($1,$2,$3,'human',$4,$5::jsonb) RETURNING id,author_id AS "authorId",author_kind AS "authorKind",body,mentions,created_at AS "createdAt",updated_at AS "updatedAt",deleted_at AS "deletedAt"`,
    [id, itemId, userId, body, JSON.stringify(mentions)])
    await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: 'comment.created', changes: { commentId: id, mentions } })
    const notificationRecipientIds: string[] = []
    for (const recipientId of mentions) if (await addNotification(client, scope, { itemId, recipientId, kind: 'mentioned',
      dedupeKey: `${itemId}:comment:${id}:mentioned:${recipientId}` })) notificationRecipientIds.push(recipientId)
    await client.query('COMMIT')
    return { scope, comment: rows[0], notificationRecipientIds }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function deleteComment(companyId: string, userId: string, conversationId: string, itemId: string, commentId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    await fetchItem(client, scope.workflow!.id, itemId, true)
    const { rows } = await client.query<{ author_id: string }>('SELECT author_id FROM project_work_item_comments WHERE id=$1 AND item_id=$2 AND deleted_at IS NULL FOR UPDATE', [commentId, itemId])
    if (!rows[0]) workflowFail('NOT_FOUND', 404, 'Comment not found.')
    if (rows[0].author_id !== userId && !scope.admin) workflowFail('FORBIDDEN', 403, 'Only the author or an administrator can delete this comment.')
    await client.query('UPDATE project_work_item_comments SET deleted_at=NOW(),deleted_by=$1,body=\'[deleted]\',updated_at=NOW() WHERE id=$2', [userId, commentId])
    await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: 'comment.deleted', changes: { commentId } })
    await client.query('COMMIT')
    return { scope }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function listActivity(companyId: string, userId: string, conversationId: string, itemId: string) {
  const { scope } = await getWorkItem(companyId, userId, conversationId, itemId)
  const { rows } = await pool.query(
    `SELECT id,item_id AS "itemId",actor_id AS "actorId",actor_kind AS "actorKind",actor_name AS "actorName",
            event_type AS "eventType",changes,source,reason,created_at AS "createdAt"
       FROM project_work_item_events WHERE workflow_id=$1 AND item_id=$2 ORDER BY created_at DESC LIMIT 300`,
    [scope.workflow!.id, itemId])
  return { scope, events: rows }
}

export async function addFileLink(companyId: string, userId: string, conversationId: string, itemId: string,
  entryId: unknown, versionId: unknown, name: unknown) {
  if (typeof entryId !== 'string' || typeof versionId !== 'string') workflowFail('INVALID_FILE_REFERENCE', 400, 'entryId and versionId required.')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    await fetchItem(client, scope.workflow!.id, itemId, true)
    const file = await projectFilesFor({ kind: 'human', id: userId, companyId }).read(scope.projectId, entryId, versionId)
    const proposedId = `wifl-${randomUUID()}`
    const fileName = cleanText(name, 255, true) ?? file.name
    const inserted = await client.query<{ id: string }>(`INSERT INTO project_work_item_file_links(id,item_id,entry_id,version_id,name,linked_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(item_id,entry_id,version_id) DO NOTHING RETURNING id`,
    [proposedId, itemId, entryId, versionId, fileName, userId])
    const id = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
      'SELECT id FROM project_work_item_file_links WHERE item_id=$1 AND entry_id=$2 AND version_id=$3',
      [itemId, entryId, versionId])).rows[0].id
    if (inserted.rows[0]) await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: 'file_link.created', changes: { entryId, versionId, name: fileName } })
    await client.query('COMMIT')
    return { scope, link: { id, itemId, entryId, versionId, name: fileName } }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function addCommitLink(companyId: string, userId: string, conversationId: string, itemId: string,
  repositoryId: unknown, commitHash: unknown, summary: unknown) {
  if (typeof repositoryId !== 'string' || typeof commitHash !== 'string' || !/^[0-9a-f]{40,64}$/iu.test(commitHash)) {
    workflowFail('INVALID_COMMIT_REFERENCE', 400, 'A repository id and full commit hash are required.')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    await fetchItem(client, scope.workflow!.id, itemId, true)
    const { rows } = await client.query<{ id: string }>('SELECT id FROM project_git_repositories WHERE id=$1 AND project_id=$2', [repositoryId, scope.projectId])
    if (!rows[0]) workflowFail('NOT_FOUND', 404, 'Git repository not found.')
    const normalizedHash = commitHash.toLowerCase()
    const cleanedSummary = cleanText(summary, 500, true)
    const proposedId = `wicl-${randomUUID()}`
    const inserted = await client.query<{ id: string }>(`INSERT INTO project_work_item_commit_links(id,item_id,repository_id,commit_hash,summary,linked_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(item_id,repository_id,commit_hash) DO NOTHING RETURNING id`,
    [proposedId, itemId, repositoryId, normalizedHash, cleanedSummary, userId])
    const id = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
      'SELECT id FROM project_work_item_commit_links WHERE item_id=$1 AND repository_id=$2 AND commit_hash=$3',
      [itemId, repositoryId, normalizedHash])).rows[0].id
    if (inserted.rows[0]) await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: 'commit_link.created', changes: { repositoryId, commitHash: normalizedHash } })
    await client.query('COMMIT')
    return { scope, link: { id, itemId, repositoryId, commitHash: normalizedHash, summary: cleanedSummary } }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function listLinks(companyId: string, userId: string, conversationId: string, itemId: string) {
  const { scope } = await getWorkItem(companyId, userId, conversationId, itemId)
  const [files, commits] = await Promise.all([
    pool.query(`SELECT id,entry_id AS "entryId",version_id AS "versionId",name,linked_by AS "linkedBy",created_at AS "createdAt"
      FROM project_work_item_file_links WHERE item_id=$1 ORDER BY created_at`, [itemId]),
    pool.query(`SELECT l.id,l.repository_id AS "repositoryId",r.name AS "repositoryName",l.commit_hash AS "commitHash",l.summary,
      l.linked_by AS "linkedBy",l.created_at AS "createdAt" FROM project_work_item_commit_links l
      JOIN project_git_repositories r ON r.id=l.repository_id WHERE l.item_id=$1 ORDER BY l.created_at`, [itemId]),
  ])
  return { scope, files: files.rows, commits: commits.rows }
}

export async function deleteLink(companyId: string, userId: string, conversationId: string, itemId: string,
  kind: 'file' | 'commit', linkId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    await fetchItem(client, scope.workflow!.id, itemId, true)
    const table = kind === 'file' ? 'project_work_item_file_links' : 'project_work_item_commit_links'
    const deleted = await client.query<{ id: string }>(`DELETE FROM ${table} WHERE id=$1 AND item_id=$2 RETURNING id`, [linkId, itemId])
    if (!deleted.rows[0]) workflowFail('NOT_FOUND', 404, 'Reference not found.')
    await addEvent(client, { workflowId: scope.workflow!.id, itemId, actorId: userId, actorName: scope.actorName,
      type: `${kind}_link.deleted`, changes: { linkId } })
    await client.query('COMMIT')
    return { scope }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function listNotifications(companyId: string, userId: string, conversationId: string, unreadOnly: boolean) {
  const scope = await requireHumanWorkflowScope(pool, companyId, userId, conversationId, { workflow: true })
  const { rows } = await pool.query(
    `SELECT n.id,n.kind,n.item_id AS "itemId",i.issue_key AS "issueKey",i.title,n.actor_id AS "actorId",
            n.read_at AS "readAt",n.created_at AS "createdAt"
       FROM project_workflow_notifications n LEFT JOIN project_work_items i ON i.id=n.item_id
      WHERE n.workflow_id=$1 AND n.conversation_id=$2 AND n.recipient_id=$3
        AND ($4::boolean=FALSE OR n.read_at IS NULL)
      ORDER BY n.created_at DESC LIMIT 100`, [scope.workflow!.id, conversationId, userId, unreadOnly])
  return { scope, notifications: rows }
}

export async function markNotificationsRead(companyId: string, userId: string, conversationId: string, ids?: unknown) {
  const scope = await requireHumanWorkflowScope(pool, companyId, userId, conversationId, { workflow: true })
  const selected = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 100) : []
  await pool.query(`UPDATE project_workflow_notifications SET read_at=COALESCE(read_at,NOW())
    WHERE workflow_id=$1 AND conversation_id=$2 AND recipient_id=$3 AND ($4::text[] = '{}'::text[] OR id=ANY($4::text[]))`,
  [scope.workflow!.id, conversationId, userId, selected])
  return { ok: true }
}

export async function requestAgentExecution(companyId: string, userId: string, conversationId: string, itemId: string,
  idempotencyKey: unknown, instruction: unknown) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = await requireHumanWorkflowScope(client, companyId, userId, conversationId, { workflow: true, mutation: true })
    const item = await fetchItem(client, scope.workflow!.id, itemId, true)
    const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 160) : ''
    if (!key) workflowFail('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotencyKey required.')
    const dispatch = await queueAgentExecution(client, scope, item, key, instruction, 'manual')
    await client.query('COMMIT')
    return { scope, item, ...dispatch }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

/** Called from membership/offboarding paths. It keeps the current assignment
 * view honest while preserving every old assignee in the append-only event log. */
export async function reconcileProjectWorkflowAssignees(companyId: string, conversationId?: string, departedParticipantId?: string): Promise<number> {
  const { rows } = await pool.query<{ id: string; workflow_id: string; assignee_id: string; project_id: string }>(
    `SELECT i.id,i.workflow_id,i.assignee_id,i.project_id FROM project_work_items i
       JOIN project_workflows w ON w.id=i.workflow_id AND w.company_id=$1
       LEFT JOIN conversations c ON c.project_id=i.project_id AND c.company_id=$1
       LEFT JOIN participants p ON p.id=i.assignee_id AND p.company_id=$1 AND p.departed_at IS NULL
      WHERE i.assignee_id IS NOT NULL AND i.archived_at IS NULL
        AND ($2::text IS NULL OR c.id=$2)
        AND ($3::text IS NULL OR i.assignee_id=$3)
        AND (c.id IS NULL OR NOT c.members @> to_jsonb(ARRAY[i.assignee_id::text]) OR p.id IS NULL)`,
    [companyId, conversationId ?? null, departedParticipantId ?? null])
  for (const row of rows) {
    await pool.query(`UPDATE project_work_items SET assignee_id=NULL,assignee_kind=NULL,version=version+1,updated_at=NOW()
      WHERE id=$1 AND assignee_id=$2`, [row.id, row.assignee_id])
    await addEvent(pool, { workflowId: row.workflow_id, itemId: row.id, actorId: 'system', actorKind: 'system', actorName: 'Cumora',
      type: 'item.assigned', source: 'system', changes: { assigneeId: { from: row.assignee_id, to: null }, reason: 'membership_revoked' } })
  }
  await cancelActiveAgentCommands(pool, rows.map(row => row.id))
  return rows.length
}

/** Cancel any pending/running workflow execution when its owning project is
 * archived. Project-file archive already revokes project leases; this also
 * closes the durable command and removes the stale targeted chat instruction. */
export async function cancelProjectWorkflowExecutions(companyId: string, projectId: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT i.id FROM project_work_items i
       JOIN project_workflows w ON w.id=i.workflow_id
      WHERE i.project_id=$1 AND w.company_id=$2`,
    [projectId, companyId],
  )
  await cancelActiveAgentCommands(pool, rows.map(row => row.id))
  return rows.length
}
