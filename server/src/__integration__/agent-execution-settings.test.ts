import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'
import { pool } from '../db/pool.js'
import { __setLlmClientOverrideForTesting } from '../llm.js'
import { issuePairingCode, pairComputer, assignAgentToComputer, listAgentsForComputer } from '../agents/computer/registry.js'

const urls: Record<string, string> = {}
const servers: Server[] = []
let device: { computerId: string; deviceToken: string }
const requested = { model: 'gpt-5.6-sol', reasoningEffort: 'high', speed: 'fast' }
before(async () => {
  await ensureSchemaOnce()
  __setLlmClientOverrideForTesting(() => { throw new Error('Model calls disabled in execution-settings tests') })
  for (const user of ['owner', 'member', '']) {
    const server = createServer(await buildApiTestApp(user))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address === 'object')
    servers.push(server); urls[user] = `http://127.0.0.1:${address.port}/api`
  }
})
beforeEach(async () => {
  await resetAllTables()
  await seedCompanyWithAgent({ companyId: 'settings-team', agentId: 'settings-agent' })
  await seedCompanyWithAgent({ companyId: 'other-team', agentId: 'other-agent' })
  await seedUserMembership('owner', 'settings-team')
  await seedUserMembership('member', 'settings-team')
  await pool.query("UPDATE company_members SET role=CASE WHEN user_id='owner' THEN 'owner' ELSE 'member' END")
  const { code } = await issuePairingCode({ companyId: 'settings-team', ownerUserId: 'owner' })
  const paired = await pairComputer({ code, hostName: 'test-host', engines: ['codex'], deferBroadcast: true })
  assert.ok(paired); device = paired
  await assignAgentToComputer({ agentId: 'settings-agent', companyId: 'settings-team', computerId: device.computerId, engine: 'codex' })
})
after(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
  await teardownAll()
  __setLlmClientOverrideForTesting(null)
})
function edit(user: string, value: unknown, id = 'settings-agent') {
  return fetch(`${urls[user]}/agents/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-company-id': 'settings-team' }, body: JSON.stringify(value) })
}
async function state() {
  const { rows } = await pool.query('SELECT * FROM participants WHERE id=$1', ['settings-agent']); return rows[0]
}
async function report(version?: number, token = device.deviceToken, id = 'settings-agent') {
  return fetch(`${urls['']}/agents/${id}/execution-report`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...requested, model: 'actual-model', source: 'codex-session', requested, settingsVersion: version ?? (await state()).execution_settings_version }) })
}

test('admin settings persist, reach the roster, and require an assigned device to confirm them', async () => {
  assert.equal((await edit('owner', requested)).status, 200)
  const [agent] = await listAgentsForComputer(device.computerId)
  assert.equal(agent.model, requested.model); assert.equal(agent.reasoningEffort, 'high'); assert.equal(agent.speed, 'fast')
  assert.equal((await state()).execution_report, null)
  assert.equal((await report()).status, 200)
  const snapshot = (await state()).execution_report
  assert.equal(snapshot.model, 'actual-model'); assert.equal(snapshot.requested.model, requested.model)
  assert.ok(snapshot.observedAt)
  const list = await (await fetch(`${urls.member}/participants`, { headers: { 'x-company-id': 'settings-team' } })).json() as Array<{ id: string; executionReport: { model: string } }>
  assert.equal(list.find(p => p.id === 'settings-agent')?.executionReport.model, 'actual-model')
  assert.equal((await report(undefined, 'not-a-device')).status, 401)
  assert.equal((await report(undefined, device.deviceToken, 'other-agent')).status, 409)
})

test('new agents retain explicit settings through creation and computer assignment', async () => {
  const response = await fetch(`${urls.owner}/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-company-id': 'settings-team' }, body: JSON.stringify({ name: 'Configured Agent', systemPrompt: 'An isolated test agent; do not execute tasks.', ...requested }) })
  assert.equal(response.status, 201, await response.clone().text())
  const { id } = await response.json() as { id: string }
  await assignAgentToComputer({ agentId: id, companyId: 'settings-team', computerId: device.computerId, engine: 'codex' })
  const agent = (await listAgentsForComputer(device.computerId)).find(p => p.id === id)
  assert.equal(agent?.model, requested.model); assert.equal(agent?.reasoningEffort, 'high'); assert.equal(agent?.speed, 'fast')
})
test('member and cross-workspace edits fail; invalid effort, speed and model are rejected', async () => {
  assert.equal((await edit('member', requested)).status, 403)
  assert.equal((await edit('owner', requested, 'other-agent')).status, 404)
  for (const value of [{ reasoningEffort: 'invalid' }, { speed: 'turbo' }, { model: 'bad\nmodel' }, { model: 5 }]) assert.equal((await edit('owner', value)).status, 400)
})
test('new settings invalidate old reports, null restores defaults, and no-op edits retain the observation', async () => {
  await edit('owner', requested)
  await report()
  const version = (await state()).execution_settings_version
  await edit('owner', { ...requested, bio: 'New bio' })
  assert.equal((await state()).execution_settings_version, version)
  assert.ok((await state()).execution_report)
  assert.equal((await edit('owner', { model: null, reasoningEffort: null, speed: null })).status, 200)
  assert.equal((await state()).execution_report, null)
  assert.equal((await report(version)).status, 409)
  const [agent] = await listAgentsForComputer(device.computerId)
  assert.equal(agent.reasoningEffort, null); assert.equal(agent.speed, null)
})
test('moving or revoking the computer prevents stale runtime confirmation', async () => {
  const version = (await state()).execution_settings_version
  const { code } = await issuePairingCode({ companyId: 'settings-team', ownerUserId: 'owner' })
  const other = await pairComputer({ code, hostName: 'other-host', engines: ['codex'], deferBroadcast: true })
  assert.ok(other)
  await assignAgentToComputer({ agentId: 'settings-agent', companyId: 'settings-team', computerId: other.computerId, engine: 'codex' })
  assert.equal((await report(version)).status, 409)
  await pool.query('UPDATE computers SET revoked_at=NOW() WHERE id=$1', [other.computerId])
  assert.equal((await report(undefined, other.deviceToken)).status, 401)
})
