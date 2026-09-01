import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { type WorkItemStatus, workflowFail } from './model.js'

type Queryable = Pick<PoolClient, 'query'>

interface AgentItemRow {
  id: string
  workflow_id: string
  project_id: string
  company_id: string
  conversation_id: string
  project_name: string
  issue_key: string
  type: 'user_story' | 'defect' | 'subtask'
  parent_id: string | null
  parent_key: string | null
  parent_title: string | null
  title: string
  description: string
  status: WorkItemStatus
  priority: string
  labels: unknown
  due_at: string | null
  user_value: string | null
  acceptance_criteria: string | null
  severity: string | null
  reproduction_steps: string | null
  expected_result: string | null
  actual_result: string | null
  environment: string | null
  resolution: string | null
  version: number
}

const AGENT_ITEM_SELECT = `i.id,i.workflow_id,i.project_id,w.company_id,c.id AS conversation_id,
  p.name AS project_name,i.issue_key,i.type,i.parent_id,parent.issue_key AS parent_key,parent.title AS parent_title,
  i.title,i.description,i.status,i.priority,i.labels,i.due_at,i.user_value,i.acceptance_criteria,
  i.severity,i.reproduction_steps,i.expected_result,i.actual_result,i.environment,i.resolution,i.version`

export interface AgentWorkflowScope { projectId: string; conversationId: string; runId: string }

export interface ExplicitAgentExecution {
  commandId: string
  itemId: string
  issueKey: string
  title: string
  conversationId: string
  instruction: string | null
}

/**
 * Resolve a durable, still-authorized human execution command from an Agent's
 * unread inbox. This is deliberately a database fact rather than a body/mention
 * heuristic: assigning an Agent only notifies it, while the separate execute
 * action creates this command row and its targeted chat message atomically.
 *
 * The scheduler, managed turn loop, and BYOA triage endpoint all use this same
 * check so a reconnect or missed transient wake cannot turn an explicit command
 * back into ordinary chat triage.
 */
export async function findExplicitAgentExecutionForInbox(
  agentId: string,
  messageIds: readonly string[],
  conversationId?: string | null,
): Promise<ExplicitAgentExecution | null> {
  if (!env.PROJECT_WORKFLOW_ENABLED || messageIds.length === 0) return null
  const { rows } = await pool.query<{
    command_id: string
    item_id: string
    issue_key: string
    title: string
    conversation_id: string
    instruction: string | null
  }>(
    `SELECT cmd.id AS command_id,cmd.item_id,i.issue_key,i.title,cmd.conversation_id,cmd.instruction
       FROM project_work_item_agent_commands cmd
       JOIN project_work_items i ON i.id=cmd.item_id AND i.project_id=cmd.project_id
         AND i.assignee_id=cmd.agent_id AND i.assignee_kind='agent' AND i.archived_at IS NULL
       JOIN project_workflows w ON w.id=i.workflow_id AND w.project_id=cmd.project_id AND w.status='active'
       JOIN projects p ON p.id=cmd.project_id AND p.company_id=w.company_id AND p.status='active'
       JOIN conversations c ON c.id=cmd.conversation_id AND c.company_id=w.company_id
         AND c.project_id=cmd.project_id AND c.members @> to_jsonb(ARRAY[$1::text])
       JOIN participants agent ON agent.id=$1 AND agent.company_id=w.company_id
         AND agent.kind='agent' AND agent.departed_at IS NULL
      WHERE cmd.agent_id=$1 AND cmd.message_id=ANY($2::text[])
        AND cmd.status IN ('pending','running')
        AND ($3::text IS NULL OR cmd.conversation_id=$3)
      ORDER BY cmd.created_at ASC LIMIT 1`,
    [agentId, [...messageIds], conversationId ?? null],
  )
  const row = rows[0]
  return row ? {
    commandId: row.command_id,
    itemId: row.item_id,
    issueKey: row.issue_key,
    title: row.title,
    conversationId: row.conversation_id,
    instruction: row.instruction,
  } : null
}

async function assertAgentLease(db: Queryable, agentId: string, scope?: AgentWorkflowScope): Promise<void> {
  if (!scope) return
  const { rows } = await db.query<{ id: string }>(
    `SELECT lease.id FROM project_file_leases lease
       JOIN projects p ON p.id=lease.project_id AND p.status='active' AND p.file_switching=FALSE
       JOIN conversations c ON c.id=lease.conversation_id AND c.project_id=lease.project_id
         AND c.members @> to_jsonb(ARRAY[$1::text])
      WHERE lease.agent_id=$1 AND lease.project_id=$2 AND lease.conversation_id=$3 AND lease.run_id=$4
        AND lease.revoked_at IS NULL AND lease.stopped_at IS NULL AND lease.expires_at>NOW()
      FOR SHARE OF lease,p,c`, [agentId, scope.projectId, scope.conversationId, scope.runId],
  )
  if (!rows[0]) workflowFail('LEASE_REVOKED', 403, 'The project task lease was revoked or the group switched projects.')
}

async function findAgentItem(db: Queryable, agentId: string, itemRef: string, lock = false, scope?: AgentWorkflowScope): Promise<AgentItemRow> {
  await assertAgentLease(db, agentId, scope)
  const { rows } = await db.query<AgentItemRow>(
    `SELECT ${AGENT_ITEM_SELECT}
       FROM project_work_items i
       JOIN project_workflows w ON w.id=i.workflow_id AND w.status='active'
       JOIN projects p ON p.id=i.project_id AND p.company_id=w.company_id AND p.status='active'
       JOIN conversations c ON c.project_id=p.id AND c.company_id=w.company_id AND c.kind='group'
         AND c.members @> to_jsonb(ARRAY[$1::text])
       JOIN participants agent ON agent.id=$1 AND agent.company_id=w.company_id
         AND agent.kind='agent' AND agent.departed_at IS NULL
       LEFT JOIN project_work_items parent ON parent.id=i.parent_id
      WHERE i.assignee_id=$1 AND i.assignee_kind='agent' AND i.archived_at IS NULL
        AND (i.id=$2 OR LOWER(i.issue_key)=LOWER($2))
        AND ($3::text IS NULL OR i.project_id=$3)
        AND ($4::text IS NULL OR c.id=$4)
      ORDER BY i.updated_at DESC${lock ? ' FOR UPDATE OF i' : ''}`,
    [agentId, itemRef.trim(), scope?.projectId ?? null, scope?.conversationId ?? null],
  )
  if (rows.length === 0) workflowFail('NOT_FOUND', 404, 'No current assigned work item matches that id or key.')
  if (rows.length > 1) workflowFail('AMBIGUOUS_ITEM', 409, 'That issue key exists in more than one mounted project; use the stable item id.')
  return rows[0]
}

async function requireActiveCommand(db: Queryable, item: AgentItemRow, agentId: string, scope?: AgentWorkflowScope): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT cmd.id FROM project_work_item_agent_commands cmd
       JOIN conversations c ON c.id=cmd.conversation_id AND c.project_id=cmd.project_id
      WHERE cmd.item_id=$1 AND cmd.agent_id=$2 AND cmd.project_id=$3
        AND cmd.conversation_id=$4 AND cmd.status IN ('pending','running')
        AND ($5::text IS NULL OR cmd.run_id IS NULL OR cmd.run_id=$5)
        AND c.members @> to_jsonb(ARRAY[$2::text])
      ORDER BY cmd.created_at DESC LIMIT 1`,
    [item.id, agentId, item.project_id, item.conversation_id, scope?.runId ?? null],
  )
  if (!rows[0]) workflowFail('EXECUTION_REQUIRED', 403, 'A human must explicitly command you to execute this item before you can change it.')
  await db.query(`UPDATE project_work_item_agent_commands
    SET status='running',run_id=COALESCE(run_id,$2),updated_at=NOW()
    WHERE id=$1 AND status IN ('pending','running')`, [rows[0].id, scope?.runId ?? null])
  return rows[0].id
}

function itemForAgent(row: AgentItemRow) {
  return {
    id: row.id, workflowId: row.workflow_id, projectId: row.project_id, projectName: row.project_name,
    conversationId: row.conversation_id, issueKey: row.issue_key, type: row.type,
    parentId: row.parent_id, parentKey: row.parent_key, parentTitle: row.parent_title,
    title: row.title, description: row.description, status: row.status, priority: row.priority,
    labels: Array.isArray(row.labels) ? row.labels : [], dueAt: row.due_at,
    userValue: row.user_value, acceptanceCriteria: row.acceptance_criteria,
    severity: row.severity, reproductionSteps: row.reproduction_steps,
    expectedResult: row.expected_result, actualResult: row.actual_result,
    environment: row.environment, resolution: row.resolution, version: Number(row.version),
    projectPath: `/projects/${row.project_id}`,
  }
}

export async function listAgentWorkflowItems(agentId: string, scope?: AgentWorkflowScope) {
  const { rows } = await pool.query<AgentItemRow>(
    `SELECT ${AGENT_ITEM_SELECT}
       FROM project_work_items i
       JOIN project_workflows w ON w.id=i.workflow_id AND w.status='active'
       JOIN projects p ON p.id=i.project_id AND p.company_id=w.company_id AND p.status='active'
       JOIN conversations c ON c.project_id=p.id AND c.company_id=w.company_id AND c.kind='group'
         AND c.members @> to_jsonb(ARRAY[$1::text])
       JOIN participants agent ON agent.id=$1 AND agent.company_id=w.company_id
         AND agent.kind='agent' AND agent.departed_at IS NULL
       LEFT JOIN project_work_items parent ON parent.id=i.parent_id
      WHERE i.assignee_id=$1 AND i.assignee_kind='agent' AND i.archived_at IS NULL
        AND ($2::text IS NULL OR i.project_id=$2) AND ($3::text IS NULL OR c.id=$3)
      ORDER BY i.updated_at DESC LIMIT 100`, [agentId, scope?.projectId ?? null, scope?.conversationId ?? null],
  )
  return rows.map(itemForAgent)
}

export async function showAgentWorkflowItem(agentId: string, itemRef: string, scope?: AgentWorkflowScope) {
  return itemForAgent(await findAgentItem(pool, agentId, itemRef, false, scope))
}

async function addAgentEvent(db: Queryable, item: AgentItemRow, agentId: string, type: string, changes: Record<string, unknown>) {
  const { rows } = await db.query<{ name: string }>('SELECT name FROM participants WHERE id=$1 AND company_id=$2', [agentId, item.company_id])
  await db.query(`INSERT INTO project_work_item_events
    (id,workflow_id,item_id,actor_id,actor_kind,actor_name,event_type,changes,source)
    VALUES($1,$2,$3,$4,'agent',$5,$6,$7::jsonb,'agent')`,
  [`wie-${randomUUID()}`, item.workflow_id, item.id, agentId, rows[0]?.name ?? agentId, type, JSON.stringify(changes)])
}

export async function addAgentWorkflowComment(agentId: string, itemRef: string, bodyInput: string, scope?: AgentWorkflowScope) {
  const body = bodyInput.trim().slice(0, 12_000)
  if (!body) workflowFail('BODY_REQUIRED', 400, 'Comment body required.')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const item = await findAgentItem(client, agentId, itemRef, true, scope)
    await requireActiveCommand(client, item, agentId, scope)
    const id = `wic-${randomUUID()}`
    await client.query(`INSERT INTO project_work_item_comments(id,item_id,author_id,author_kind,body,mentions)
      VALUES($1,$2,$3,'agent',$4,'[]'::jsonb)`, [id, item.id, agentId, body])
    await addAgentEvent(client, item, agentId, 'comment.created', { commentId: id })
    await client.query('COMMIT')
    return { id, itemId: item.id, issueKey: item.issue_key, body }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

const AGENT_STATUSES = new Set<WorkItemStatus>(['in_progress', 'blocked', 'in_review'])

export async function updateAgentWorkflowStatus(agentId: string, itemRef: string, statusInput: string, scope?: AgentWorkflowScope) {
  if (!AGENT_STATUSES.has(statusInput as WorkItemStatus)) {
    workflowFail('INVALID_AGENT_STATUS', 400, 'Agent status must be in_progress, blocked, or in_review. Humans complete or cancel items.')
  }
  const status = statusInput as WorkItemStatus
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const item = await findAgentItem(client, agentId, itemRef, true, scope)
    await requireActiveCommand(client, item, agentId, scope)
    if (item.status !== status) {
      await client.query(`UPDATE project_work_items SET status=$2,resolution=NULL,version=version+1,updated_at=NOW() WHERE id=$1`, [item.id, status])
      await addAgentEvent(client, item, agentId, 'item.status_changed', { status: { from: item.status, to: status } })
    }
    await client.query('COMMIT')
    return { itemId: item.id, issueKey: item.issue_key, status }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function linkAgentWorkflowCommit(agentId: string, itemRef: string, repositoryId: string, commitHashInput: string, summaryInput = '', scope?: AgentWorkflowScope) {
  const commitHash = commitHashInput.trim().toLowerCase()
  if (!repositoryId.trim() || !/^[0-9a-f]{40,64}$/u.test(commitHash)) {
    workflowFail('INVALID_COMMIT_REFERENCE', 400, 'A repository id and full commit hash are required.')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const item = await findAgentItem(client, agentId, itemRef, true, scope)
    await requireActiveCommand(client, item, agentId, scope)
    const repo = await client.query<{ name: string }>(
      'SELECT name FROM project_git_repositories WHERE id=$1 AND project_id=$2', [repositoryId.trim(), item.project_id])
    if (!repo.rows[0]) workflowFail('NOT_FOUND', 404, 'Git repository not found in this item project.')
    const id = `wicl-${randomUUID()}`
    const inserted = await client.query<{ id: string }>(`INSERT INTO project_work_item_commit_links
      (id,item_id,repository_id,commit_hash,summary,linked_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(item_id,repository_id,commit_hash) DO NOTHING RETURNING id`,
    [id, item.id, repositoryId.trim(), commitHash, summaryInput.trim().slice(0, 500) || null, agentId])
    const linkId = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
      'SELECT id FROM project_work_item_commit_links WHERE item_id=$1 AND repository_id=$2 AND commit_hash=$3',
      [item.id, repositoryId.trim(), commitHash])).rows[0].id
    if (inserted.rows[0]) await addAgentEvent(client, item, agentId, 'commit_link.created', { repositoryId: repositoryId.trim(), commitHash })
    await client.query('COMMIT')
    return { id: linkId, itemId: item.id, issueKey: item.issue_key, repositoryId: repositoryId.trim(), repositoryName: repo.rows[0].name, commitHash }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function markAgentExecutionRunStarted(agentId: string, companyId: string, runId: string, inputMessageIds: string[]) {
  if (inputMessageIds.length === 0) return 0
  const result = await pool.query(
    `UPDATE project_work_item_agent_commands cmd SET status='running',run_id=$3,updated_at=NOW()
       FROM conversations c
      WHERE cmd.message_id=ANY($1::text[]) AND cmd.agent_id=$2 AND cmd.status='pending'
        AND c.id=cmd.conversation_id AND c.company_id=$4 AND c.project_id=cmd.project_id
        AND c.members @> to_jsonb(ARRAY[$2::text])`,
    [inputMessageIds, agentId, runId, companyId],
  )
  return result.rowCount ?? 0
}

export async function markAgentExecutionRunFinished(agentId: string, runId: string, status: 'running' | 'completed' | 'failed' | 'skipped') {
  if (status === 'running') return 0
  const commandStatus = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'canceled'
  const result = await pool.query(
    `UPDATE project_work_item_agent_commands SET status=$3,updated_at=NOW()
      WHERE agent_id=$1 AND run_id=$2 AND status='running'`, [agentId, runId, commandStatus],
  )
  return result.rowCount ?? 0
}
