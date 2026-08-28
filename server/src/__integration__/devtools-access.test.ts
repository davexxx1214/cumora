import { test, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, seedCompanyWithAgent, teardownAll } from './_helpers.js'
import { pool } from '../db/pool.js'
import { env } from '../env.js'

const users = ['owner', 'admin', 'member', 'outsider', ''] as const
type User = typeof users[number]
const servers: Server[] = []
const urls = new Map<User, string>()
const initialNodeEnv = env.NODE_ENV
const protectedPaths = [
  '/agents/observability/runs',
  '/agents/observability/runs/observe-run/events',
  '/agents/observability/triage',
  '/agents/observability/llm-spend',
  '/devtools/agent-workspace?agentId=observe-agent',
  '/devtools/agent-workspace/file?agentId=observe-agent&path=notes.md',
]

before(async () => {
  await ensureSchemaOnce()
  for (const user of users) {
    const server = createServer(await buildApiTestApp(user))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    servers.push(server)
    urls.set(user, `http://127.0.0.1:${address.port}`)
  }
})

beforeEach(async () => {
  await resetAllTables()
  await pool.query("INSERT INTO companies (id,name,slug) VALUES ('co-observe','Observe','observe'),('co-other','Other','other')")
  for (const role of ['owner', 'admin', 'member']) {
    await seedUserMembership(role, 'co-observe')
    await pool.query("UPDATE company_members SET role=$1 WHERE user_id=$1 AND company_id='co-observe'", [role])
  }
  // The same person is an admin here but only a member in the other workspace.
  await seedUserMembership('admin', 'co-other')
  await pool.query("UPDATE company_members SET role='member' WHERE user_id='admin' AND company_id='co-other'")
  await seedCompanyWithAgent({ companyId: 'co-observe', agentId: 'observe-agent' })
  await pool.query("INSERT INTO agent_runs (id,agent_id,company_id,summary) VALUES ('observe-run','observe-agent','co-observe','private trace'),('other-run','other-agent','co-other','other private trace')")
  await pool.query("INSERT INTO agent_events (id,run_id,agent_id,company_id,kind,title) VALUES ('observe-event','observe-run','observe-agent','co-observe','tool.start','private event')")
  await pool.query("INSERT INTO agent_workspace (agent_id,company_id,path,body) VALUES ('observe-agent','co-observe','notes.md','private workspace notes')")
})

afterEach(() => { env.NODE_ENV = initialNodeEnv })
after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await teardownAll()
})

function request(user: User, path: string, requested = false, companyId = 'co-observe') {
  return fetch(`${urls.get(user)}/api${path}`, {
    headers: { 'x-company-id': companyId, 'x-cumora-dev-mode': requested ? '1' : '0' },
  })
}

test('[integration] developer capabilities require a workspace admin in both development and production', async () => {
  for (const mode of ['development', 'production']) {
    env.NODE_ENV = mode
    for (const user of ['owner', 'admin', 'member'] as const) {
      for (const requested of [false, true]) {
        const response = await request(user, '/devtools/capabilities', requested)
        assert.equal(response.status, 200)
        const caps = await response.json() as { enabled: boolean; canEnable: boolean }
        const privileged = user !== 'member'
        assert.equal(caps.canEnable, privileged, `${mode}/${user}/${requested}`)
        assert.equal(caps.enabled, privileged && (mode === 'development' || requested), `${mode}/${user}/${requested}`)
      }
    }
  }
})

test('[integration] ordinary members cannot read any observability panel or enable it with a request header', async () => {
  for (const mode of ['development', 'production']) {
    env.NODE_ENV = mode
    for (const requested of [false, true]) {
      for (const path of protectedPaths) {
        assert.equal((await request('member', path, requested)).status, 403, `${mode}/${requested}/${path}`)
      }
    }
  }
})

test('[integration] owners and admins retain access to traces, workspace files and cost panels', async () => {
  for (const mode of ['development', 'production']) {
    env.NODE_ENV = mode
    for (const user of ['owner', 'admin'] as const) {
      const requested = mode === 'production'
      for (const path of protectedPaths) {
        const response = await request(user, path, requested)
        assert.equal(response.status, 200, `${mode}/${user}/${path}: ${await response.clone().text()}`)
      }
      const runs = await (await request(user, protectedPaths[0], requested)).json() as Array<{ id: string }>
      assert.deepEqual(runs.map((run) => run.id), ['observe-run'])
    }
  }
})

test('[integration] production admins still explicitly enable developer mode', async () => {
  env.NODE_ENV = 'production'
  for (const path of protectedPaths) {
    assert.equal((await request('admin', path)).status, 403, path)
  }
})

test('[integration] observability authorization follows the requested workspace and current role', async () => {
  env.NODE_ENV = 'development'
  const caps = await (await request('admin', '/devtools/capabilities', true, 'co-other')).json() as { enabled: boolean }
  assert.equal(caps.enabled, false)
  assert.equal((await request('admin', protectedPaths[0], true, 'co-other')).status, 403)
  assert.equal((await request('admin', '/agents/observability/runs/other-run/events', true)).status, 404)
  assert.equal((await request('outsider', protectedPaths[0], true)).status, 403)
  await pool.query("UPDATE company_members SET role='member' WHERE company_id='co-observe' AND user_id='admin'")
  assert.equal((await request('admin', protectedPaths[0], true)).status, 403)
})

test('[integration] unauthenticated callers cannot read developer capabilities or observability data', async () => {
  for (const path of ['/devtools/capabilities', ...protectedPaths]) {
    assert.equal((await request('', path, true)).status, 401, path)
  }
})
