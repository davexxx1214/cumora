import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { runProjectCli } from '../project-files/scoped-cli.js'
import { createProjectLease, stopProjectLease } from '../project-files/service.js'
import {
  findExplicitAgentExecutionForInbox, markAgentExecutionRunFinished, markAgentExecutionRunStarted,
  updateAgentWorkflowStatus,
} from '../project-workflow/agent-service.js'
import { reconcileProjectWorkflowAssignees } from '../project-workflow/service.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const users = ['owner', 'member', 'peer', 'outsider'] as const
const servers: Server[] = []
const urls = new Map<string, string>()
let projectRoot = ''

before(async () => {
  env.PROJECT_WORKFLOW_ENABLED = true
  projectRoot = await mkdtemp(join(tmpdir(), 'cumora-workflow-project-'))
  env.PROJECT_FILES_ENABLED = true
  env.PROJECT_FILES_ROOT = projectRoot
  await ensureSchemaOnce()
  for (const user of users) {
    const app = await buildApiTestApp(user)
    const server = createServer(app).listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const address = server.address()!
    assert.equal(typeof address, 'object')
    urls.set(user, `http://127.0.0.1:${(address as { port: number }).port}`)
  }
})

beforeEach(async () => {
  await resetAllTables()
  await pool.query("INSERT INTO companies(id,name,slug,owner_user_id) VALUES ('co-flow','Flow','flow','owner')")
  for (const user of users) await seedUserMembership(user, 'co-flow', { displayName: user.toUpperCase() })
  await pool.query("UPDATE company_members SET role='member' WHERE user_id <> 'owner'")
  await pool.query("UPDATE company_members SET role='owner' WHERE user_id='owner'")
  await pool.query("INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES ('agent','co-flow','agent','Agent','A','#000','avail')")
  await pool.query("INSERT INTO projects(id,company_id,name) VALUES ('p-flow','co-flow','Easy AR'),('p-next','co-flow','Next'),('p-third','co-flow','Third')")
  await pool.query(`INSERT INTO conversations(id,kind,title,company_id,members,project_id) VALUES
    ('g-flow','group','Flow','co-flow','["owner","member","peer","agent"]','p-flow'),
    ('g-next','group','Next','co-flow','["owner","member"]','p-next')`)
})

after(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
  await teardownAll()
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true })
})

function request(user: string, path: string, method = 'GET', body?: unknown) {
  return fetch(`${urls.get(user)}/api/project-workflows${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-company-id': 'co-flow' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function apiRequest(user: string, path: string, method = 'GET', body?: unknown) {
  return fetch(`${urls.get(user)}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-company-id': 'co-flow' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function enable() {
  const response = await request('owner', '/conversations/g-flow', 'POST', { issuePrefix: 'EASY' })
  assert.equal(response.status, 201, await response.clone().text())
  return response.json() as Promise<{ id: string; issuePrefix: string }>
}

async function create(user: string, body: Record<string, unknown>) {
  const response = await request(user, '/conversations/g-flow/items', 'POST', body)
  assert.equal(response.status, 201, await response.clone().text())
  return response.json() as Promise<{ id: string; issueNumber: number; issueKey: string; version: number; status: string; assigneeId: string | null }>
}

test('[integration] only admins enable a project workflow, but ordinary group members create and edit items', async () => {
  assert.equal((await request('member', '/conversations/g-flow', 'POST', { issuePrefix: 'NOPE' })).status, 403)
  const workflow = await enable()
  assert.equal(workflow.issuePrefix, 'EASY')
  const story = await create('member', { type: 'user_story', title: 'First story', userValue: 'Useful', assigneeId: 'peer' })
  assert.equal(story.issueKey, 'EASY-1')
  assert.equal(story.assigneeId, 'peer')
  const updated = await request('peer', `/conversations/g-flow/items/${story.id}`, 'PATCH', {
    expectedVersion: story.version, status: 'in_progress', priority: 'high', title: 'First story edited',
  })
  assert.equal(updated.status, 200, await updated.clone().text())
  const body = await updated.json() as { version: number; status: string; title: string }
  assert.equal(body.version, story.version + 1)
  assert.equal(body.status, 'in_progress')
  assert.equal(body.title, 'First story edited')
  assert.equal((await request('outsider', '/conversations/g-flow')).status, 404)
})

test('[integration] project issue numbers are allocated atomically and optimistic writes never overwrite', async () => {
  await enable()
  const created = await Promise.all(Array.from({ length: 20 }, (_, index) => create(index % 2 ? 'member' : 'peer', {
    type: index % 3 ? 'user_story' : 'defect', title: `Concurrent ${index}`,
  })))
  assert.deepEqual(created.map(item => item.issueNumber).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1))
  const item = created[0]
  const [first, stale] = await Promise.all([
    request('member', `/conversations/g-flow/items/${item.id}`, 'PATCH', { expectedVersion: item.version, title: 'winner' }),
    request('peer', `/conversations/g-flow/items/${item.id}`, 'PATCH', { expectedVersion: item.version, title: 'stale' }),
  ])
  assert.deepEqual([first.status, stale.status].sort(), [200, 409])
  const conflict = first.status === 409 ? first : stale
  const conflictBody = await conflict.json() as { code: string; current: { title: string; version: number } }
  assert.equal(conflictBody.code, 'VERSION_CONFLICT')
  assert.equal(conflictBody.current.version, item.version + 1)
})

test('[integration] subtasks are one level and incomplete children block parent completion unless an admin explains a force', async () => {
  await enable()
  const parent = await create('member', { type: 'defect', title: 'Broken export', severity: 'high' })
  const child = await create('peer', { type: 'subtask', parentId: parent.id, title: 'Reproduce' })
  assert.equal((await request('member', '/conversations/g-flow/items', 'POST', {
    type: 'subtask', parentId: child.id, title: 'Nested',
  })).status, 400)
  const denied = await request('member', `/conversations/g-flow/items/${parent.id}`, 'PATCH', {
    expectedVersion: parent.version, status: 'done', resolution: 'fixed',
  })
  assert.equal(denied.status, 409)
  assert.equal((await denied.json() as { code: string }).code, 'SUBTASKS_INCOMPLETE')
  const forced = await request('owner', `/conversations/g-flow/items/${parent.id}`, 'PATCH', {
    expectedVersion: parent.version, status: 'done', resolution: 'fixed', forceReason: 'Accepted with follow-up work',
  })
  assert.equal(forced.status, 200, await forced.clone().text())
  const events = await (await request('member', `/conversations/g-flow/items/${parent.id}/activity`)).json() as Array<{ eventType: string; reason: string | null }>
  assert.ok(events.some(event => event.eventType === 'item.force_completed' && event.reason === 'Accepted with follow-up work'))
})

test('[integration] assigning an Agent only records a notification; explicit execution is separate and idempotent', async () => {
  await enable()
  const item = await create('member', { type: 'user_story', title: 'Agent work', assigneeId: 'agent' })
  assert.equal((await pool.query('SELECT 1 FROM project_work_item_agent_commands')).rowCount, 0)
  const notifications = await pool.query<{ kind: string; recipient_id: string }>('SELECT kind,recipient_id FROM project_workflow_notifications')
  assert.deepEqual(notifications.rows, [{ kind: 'assigned', recipient_id: 'agent' }])
  const payload = { idempotencyKey: 'explicit-command-1', instruction: 'Implement the acceptance criteria.' }
  const first = await request('member', `/conversations/g-flow/items/${item.id}/execute`, 'POST', payload)
  const second = await request('member', `/conversations/g-flow/items/${item.id}/execute`, 'POST', payload)
  assert.equal(first.status, 202, await first.clone().text())
  assert.equal(second.status, 202, await second.clone().text())
  assert.equal((await first.json() as { id: string }).id, (await second.json() as { id: string }).id)
  assert.equal((await pool.query('SELECT 1 FROM project_work_item_agent_commands')).rowCount, 1)
  assert.equal((await pool.query('SELECT 1 FROM agent_runs')).rowCount, 0)
  const messages = await pool.query<{ id: string; agent_recipient_ids: string[]; client_id: string }>(
    'SELECT id,agent_recipient_ids,client_id FROM messages')
  assert.equal(messages.rowCount, 1)
  assert.deepEqual(messages.rows[0].agent_recipient_ids, ['agent'])
  assert.match(messages.rows[0].client_id, /^workflow-command:/)
  const explicit = await findExplicitAgentExecutionForInbox('agent', [messages.rows[0].id], 'g-flow')
  assert.equal(explicit?.issueKey, item.issueKey)
  assert.equal(explicit?.conversationId, 'g-flow')
  assert.equal((await pool.query("SELECT 1 FROM project_work_item_events WHERE event_type='agent.execution_requested'")).rowCount, 1)
  assert.equal((await pool.query("SELECT 1 FROM project_workflow_notifications WHERE kind='agent_execute'")).rowCount, 1)
})

test('[integration] controlled Agent tools require explicit execution and keep completion human-owned', async () => {
  await enable()
  const item = await create('member', { type: 'defect', title: 'Agent fixes it', assigneeId: 'agent' })
  await assert.rejects(() => updateAgentWorkflowStatus('agent', item.issueKey, 'in_progress'), /explicitly command/i)
  const executed = await request('member', `/conversations/g-flow/items/${item.id}/execute`, 'POST', {
    idempotencyKey: 'agent-tools-1', instruction: 'Fix and prepare for review.',
  })
  assert.equal(executed.status, 202, await executed.clone().text())
  const command = await executed.json() as { id: string; messageId: string }
  await pool.query(`INSERT INTO agent_runs(id,agent_id,company_id,trigger,status,stage,input_message_ids,inbox_count)
    VALUES('run-workflow','agent','co-flow','{}','running','created',$1::jsonb,1)`, [JSON.stringify([command.messageId])])
  assert.equal(await markAgentExecutionRunStarted('agent', 'co-flow', 'run-workflow', [command.messageId]), 1)
  const bindingRow = await pool.query<{ file_binding_version: string }>('SELECT file_binding_version::text FROM projects WHERE id=$1', ['p-flow'])
  const lease = await createProjectLease({ agentId: 'agent', companyId: 'co-flow', conversationId: 'g-flow',
    runId: 'run-workflow', bindingVersion: `p-flow:${bindingRow.rows[0].file_binding_version}` })
  const shown = await runProjectCli(lease.token, ['workflow', 'show', item.issueKey]) as { value: { projectId: string } }
  assert.equal(shown.value.projectId, 'p-flow')
  const progressing = await runProjectCli(lease.token, ['workflow', 'status', item.issueKey, 'in_progress']) as { value: { status: string } }
  assert.equal(progressing.value.status, 'in_progress')
  await assert.rejects(() => runProjectCli(lease.token, ['workflow', 'status', item.issueKey, 'done']), /Humans complete/i)
  const commented = await runProjectCli(lease.token, ['workflow', 'comment', item.issueKey, 'Implementation is ready.']) as { value: { issueKey: string } }
  assert.equal(commented.value.issueKey, item.issueKey)
  await pool.query(`INSERT INTO project_git_repositories
    (id,project_id,name,repository_url,host,updated_by) VALUES
    ('repo-flow','p-flow','app','https://github.com/example/app.git','github.com','owner')`)
  const linked = await runProjectCli(lease.token, ['workflow', 'link-commit', item.issueKey, 'repo-flow', 'a'.repeat(40), 'Fix export']) as { value: { commitHash: string } }
  assert.equal(linked.value.commitHash, 'a'.repeat(40))
  const review = await runProjectCli(lease.token, ['workflow', 'status', item.issueKey, 'in_review']) as { value: { status: string } }
  assert.equal(review.value.status, 'in_review')
  assert.equal(await markAgentExecutionRunFinished('agent', 'run-workflow', 'completed'), 1)
  const stored = await pool.query<{ status: string; run_id: string }>('SELECT status,run_id FROM project_work_item_agent_commands WHERE id=$1', [command.id])
  assert.deepEqual(stored.rows[0], { status: 'completed', run_id: 'run-workflow' })
  assert.equal((await pool.query("SELECT 1 FROM project_work_item_events WHERE actor_kind='agent' AND source='agent'")).rowCount, 4)
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-flow' })
})

test('[integration] switching project scopes the view and membership revocation clears the live assignee only', async () => {
  await enable()
  const item = await create('member', { type: 'user_story', title: 'Scoped', assigneeId: 'peer' })
  assert.equal((await request('member', '/conversations/g-next/items')).status, 409)
  await pool.query(`UPDATE conversations SET members='["owner","member","agent"]'::jsonb WHERE id='g-flow'`)
  assert.equal(await reconcileProjectWorkflowAssignees('co-flow', 'g-flow', 'peer'), 1)
  const after = await (await request('member', `/conversations/g-flow/items/${item.id}`)).json() as { assigneeId: string | null }
  assert.equal(after.assigneeId, null)
  const events = await pool.query<{ changes: { assigneeId?: { from: string; to: null } } }>(
    "SELECT changes FROM project_work_item_events WHERE item_id=$1 AND actor_kind='system'", [item.id])
  assert.equal(events.rows[0].changes.assigneeId?.from, 'peer')
})

test('[integration] reassignment cancels a running Agent command, revokes its lease and removes its inbox audience', async () => {
  await enable()
  const item = await create('member', { type: 'user_story', title: 'Do not run stale work', assigneeId: 'agent' })
  const execution = await request('member', `/conversations/g-flow/items/${item.id}/execute`, 'POST', {
    idempotencyKey: 'cancel-on-reassign', instruction: 'This will be reassigned.',
  })
  assert.equal(execution.status, 202, await execution.clone().text())
  const requested = await execution.json() as { messageId: string }
  await pool.query(`INSERT INTO agent_runs(id,agent_id,company_id,trigger,status,stage,input_message_ids,inbox_count)
    VALUES('run-reassigned','agent','co-flow','{}','running','created',$1::jsonb,1)`, [JSON.stringify([requested.messageId])])
  assert.equal(await markAgentExecutionRunStarted('agent', 'co-flow', 'run-reassigned', [requested.messageId]), 1)
  const binding = await pool.query<{ file_binding_version: string }>('SELECT file_binding_version::text FROM projects WHERE id=$1', ['p-flow'])
  const lease = await createProjectLease({ agentId: 'agent', companyId: 'co-flow', conversationId: 'g-flow',
    runId: 'run-reassigned', bindingVersion: `p-flow:${binding.rows[0].file_binding_version}` })
  const updated = await request('peer', `/conversations/g-flow/items/${item.id}`, 'PATCH', {
    expectedVersion: item.version, assigneeId: 'peer',
  })
  assert.equal(updated.status, 200, await updated.clone().text())
  const command = await pool.query<{ status: string; message_id: string }>('SELECT status,message_id FROM project_work_item_agent_commands')
  assert.equal(command.rows[0].status, 'canceled')
  const message = await pool.query<{ body: string; agent_recipient_ids: string[] }>('SELECT body,agent_recipient_ids FROM messages WHERE id=$1', [command.rows[0].message_id])
  assert.deepEqual(message.rows[0].agent_recipient_ids, [])
  assert.match(message.rows[0].body, /^\[已取消，不要执行\]/u)
  assert.equal(await findExplicitAgentExecutionForInbox('agent', [command.rows[0].message_id], 'g-flow'), null)
  const revoked = await pool.query<{ revoked_at: string | null }>('SELECT revoked_at FROM project_file_leases WHERE id=$1', [lease.id])
  assert.ok(revoked.rows[0].revoked_at)
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-flow' })
})

test('[integration] permanent deletion cancels a pending command before retaining only its harmless chat history', async () => {
  await enable()
  const item = await create('member', { type: 'defect', title: 'Delete safely', assigneeId: 'agent' })
  const execution = await request('member', `/conversations/g-flow/items/${item.id}/execute`, 'POST', {
    idempotencyKey: 'cancel-on-delete', instruction: 'This item will be deleted.',
  })
  const command = await execution.json() as { messageId: string }
  const deleted = await request('owner', `/conversations/g-flow/items/${item.id}`, 'DELETE', { reason: 'Test cleanup' })
  assert.equal(deleted.status, 200, await deleted.clone().text())
  assert.equal((await pool.query('SELECT 1 FROM project_work_item_agent_commands')).rowCount, 0)
  const message = await pool.query<{ body: string; agent_recipient_ids: string[] }>(
    'SELECT body,agent_recipient_ids FROM messages WHERE id=$1', [command.messageId])
  assert.deepEqual(message.rows[0].agent_recipient_ids, [])
  assert.match(message.rows[0].body, /^\[已取消，不要执行\]/u)
})

test('[integration] switching projects cancels the old workflow command and exposes only the new project workflow', async () => {
  await enable()
  const item = await create('member', { type: 'user_story', title: 'Belongs to the old project', assigneeId: 'agent' })
  const execution = await request('member', `/conversations/g-flow/items/${item.id}/execute`, 'POST', {
    idempotencyKey: 'cancel-on-project-switch', instruction: 'Do not carry this into the next project.',
  })
  assert.equal(execution.status, 202, await execution.clone().text())
  const command = await execution.json() as { messageId: string }

  const switched = await apiRequest('owner', '/conversations/g-flow/project', 'POST', { projectId: 'p-third' })
  assert.equal(switched.status, 200, await switched.clone().text())
  const stored = await pool.query<{ status: string }>('SELECT status FROM project_work_item_agent_commands')
  assert.equal(stored.rows[0].status, 'canceled')
  const message = await pool.query<{ agent_recipient_ids: string[] }>('SELECT agent_recipient_ids FROM messages WHERE id=$1', [command.messageId])
  assert.deepEqual(message.rows[0].agent_recipient_ids, [])
  const current = await request('member', '/conversations/g-flow')
  assert.equal(current.status, 200, await current.clone().text())
  const currentBody = await current.json() as { project: { id: string }; workflow: unknown }
  assert.equal(currentBody.project.id, 'p-third')
  assert.equal(currentBody.workflow, null)
})
