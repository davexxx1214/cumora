/**
 * Integration tests for tier structural limits and self-hosted seat overrides.
 */
import { test, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'
import { env } from '../env.js'

const FREE_USER_ID = 'u-free-limit'
const initialHumanLimit = env.WORKSPACE_HUMAN_LIMIT
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(FREE_USER_ID)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  env.WORKSPACE_HUMAN_LIMIT = undefined
  await resetAllTables()
})

afterEach(() => {
  env.WORKSPACE_HUMAN_LIMIT = initialHumanLimit
})

after(async () => {
  await teardownAll(server)
})

async function seedUser(userId: string, tier: 'free' | 'pro' | 'max' = 'free'): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET tier = EXCLUDED.tier`,
    [userId, `${userId}@test.local`, userId, tier],
  )
}

async function seedCompanyWithOwner(companyId: string, ownerId: string, tier: 'free' | 'pro' | 'max' = 'free'): Promise<void> {
  await seedUser(ownerId, tier)
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, $2, $3, $4)`,
    [companyId, `Company ${companyId}`, companyId, ownerId],
  )
  await seedHumanMember(companyId, ownerId, 'owner', tier)
}

async function seedHumanMember(
  companyId: string,
  userId: string,
  role = 'member',
  tier: 'free' | 'pro' | 'max' = 'free',
): Promise<void> {
  await seedUser(userId, tier)
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [companyId, userId, role],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', $3, NULL, $4, '#abcdef', 'avail')`,
    [userId, companyId, userId, userId.slice(0, 1).toUpperCase()],
  )
}

async function seedActiveAgents(companyId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, system_prompt)
       VALUES ($1, $2, 'agent', $3, 'agent', $4, '#abcdef', 'avail', 'test agent prompt')`,
      [`agent-${i}`, companyId, `Agent ${i}`, 'A'],
    )
  }
}

async function seedInvitation(companyId: string, invitedBy: string): Promise<string> {
  const token = `invite-${companyId}`
  const tokenHash = createHash('sha256').update(token).digest('base64url')
  await pool.query(
    `INSERT INTO company_invitations
       (token_hash, company_id, invited_by, email, role, note, max_uses, expires_at)
     VALUES ($1, $2, $3, NULL, 'member', NULL, 1, NOW() + INTERVAL '1 day')`,
    [tokenHash, companyId, invitedBy],
  )
  return token
}

test('[integration] free users cannot create a fourth company', async () => {
  for (let i = 0; i < 3; i++) {
    await seedCompanyWithOwner(`co-existing-${i}`, FREE_USER_ID)
  }

  const res = await fetch(`${baseUrl}/api/companies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fourth Company' }),
  })
  const body = await res.json() as { error?: string }

  assert.equal(res.status, 403)
  assert.match(body.error ?? '', /at most 3 companies/)
})

test('[integration] free users cannot accept an invite into a fourth company', async () => {
  for (let i = 0; i < 3; i++) {
    await seedCompanyWithOwner(`co-member-${i}`, FREE_USER_ID)
  }
  await seedCompanyWithOwner('co-target', 'u-target-owner', 'pro')
  const token = await seedInvitation('co-target', 'u-target-owner')

  const res = await fetch(`${baseUrl}/api/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
  })
  const body = await res.json() as { error?: string }

  assert.equal(res.status, 403)
  assert.match(body.error ?? '', /at most 3 companies/)
})

test('[integration] free workspaces cannot create an eleventh active agent', async () => {
  await seedCompanyWithOwner('co-agent-limit', FREE_USER_ID)
  await seedActiveAgents('co-agent-limit', 10)

  const res = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': 'co-agent-limit' },
    body: JSON.stringify({
      id: 'eleventh-agent',
      name: 'Eleventh Agent',
      role: 'Agent',
      systemPrompt: 'A test agent prompt long enough.',
    }),
  })
  const body = await res.json() as { error?: string }

  assert.equal(res.status, 403)
  assert.match(body.error ?? '', /at most 10 active agents/)
})

test('[integration] free workspaces cannot accept a sixth human member', async () => {
  await seedUser(FREE_USER_ID)
  await seedCompanyWithOwner('co-human-limit', 'u-human-owner')
  await seedHumanMember('co-human-limit', 'u-human-two')
  await seedHumanMember('co-human-limit', 'u-human-three')
  await seedHumanMember('co-human-limit', 'u-human-four')
  await seedHumanMember('co-human-limit', 'u-human-five')
  const token = await seedInvitation('co-human-limit', 'u-human-owner')

  const res = await fetch(`${baseUrl}/api/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
  })
  const body = await res.json() as { error?: string }

  assert.equal(res.status, 403)
  assert.match(body.error ?? '', /at most 5 human members/)
})

for (const tier of ['free', 'pro', 'max'] as const) {
  test(`[integration] ${tier} workspace links use the configured 50-person limit`, async () => {
    env.WORKSPACE_HUMAN_LIMIT = 50
    const companyId = 'co-link-limit'
    await seedCompanyWithOwner(companyId, FREE_USER_ID, tier)
    for (let i = 1; i < 4; i++) {
      await seedHumanMember(companyId, `u-link-${i}`)
    }

    const res = await fetch(`${baseUrl}/api/companies/${companyId}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ multiUse: true }),
    })
    const body = await res.json() as { maxUses: number }

    assert.equal(res.status, 201)
    assert.equal(body.maxUses, 46)
  })
}

test('[integration] a configured workspace accepts its 50th human member', async () => {
  env.WORKSPACE_HUMAN_LIMIT = 50
  await seedUser(FREE_USER_ID)
  const companyId = 'co-50th-member'
  await seedCompanyWithOwner(companyId, 'u-human-owner')
  for (let i = 1; i < 49; i++) {
    await seedHumanMember(companyId, `u-human-${i}`)
  }
  const token = await seedInvitation(companyId, 'u-human-owner')

  const res = await fetch(`${baseUrl}/api/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
  })
  const body = await res.json() as { ok?: boolean }

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  const { rows } = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM company_members WHERE company_id = $1', [companyId],
  )
  assert.equal(rows[0].count, 50)
})

test('[integration] a configured workspace rejects a 51st human member', async () => {
  env.WORKSPACE_HUMAN_LIMIT = 50
  await seedUser(FREE_USER_ID)
  const companyId = 'co-51st-member'
  await seedCompanyWithOwner(companyId, 'u-human-owner')
  for (let i = 1; i < 50; i++) {
    await seedHumanMember(companyId, `u-human-${i}`)
  }
  const token = await seedInvitation(companyId, 'u-human-owner')

  const res = await fetch(`${baseUrl}/api/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
  })
  const body = await res.json() as { error?: string }

  assert.equal(res.status, 403)
  assert.match(body.error ?? '', /at most 50 human members/)
  const { rows } = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM company_members WHERE company_id = $1', [companyId],
  )
  assert.equal(rows[0].count, 50)
})

test('[integration] a configured workspace cannot create invitations when all 50 seats are used', async () => {
  env.WORKSPACE_HUMAN_LIMIT = 50
  const companyId = 'co-full-workspace'
  await seedCompanyWithOwner(companyId, FREE_USER_ID)
  for (let i = 1; i < 50; i++) {
    await seedHumanMember(companyId, `u-human-${i}`)
  }

  const res = await fetch(`${baseUrl}/api/companies/${companyId}/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ multiUse: true }),
  })
  const body = await res.json() as { error?: string }

  assert.equal(res.status, 403)
  assert.match(body.error ?? '', /at most 50 human members/)
})
