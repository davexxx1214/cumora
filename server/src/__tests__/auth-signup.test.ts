/**
 * Unit tests for local email+password registration (attemptPasswordSignup).
 * Mocks pool.query / pool.connect — no live Postgres required.
 *
 * Run: node --import tsx --test server/src/__tests__/auth-signup.test.ts
 */
import { test, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENAI_API_KEY ??= 'test-key'

const { pool } = await import('../db/pool.js')
const { attemptPasswordSignup } = await import('../auth.js')

type PoolQueryFn = typeof pool.query
type PoolConnectFn = typeof pool.connect
const savedQuery = pool.query
const savedConnect = pool.connect

afterEach(() => {
  ;(pool as unknown as { query: PoolQueryFn }).query = savedQuery
  ;(pool as unknown as { connect: PoolConnectFn }).connect = savedConnect
})

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
})

function installMock(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const query = (async (sql: string, params: unknown[] = []) => {
    return handler(sql, params)
  }) as unknown as PoolQueryFn
  ;(pool as unknown as { query: PoolQueryFn }).query = query
  ;(pool as unknown as { connect: PoolConnectFn }).connect = (async () => ({
    query,
    release() { /* no-op */ },
  })) as unknown as PoolConnectFn
}

test('attemptPasswordSignup: success creates user + personal company', async () => {
  const recorded: Array<{ success: boolean; reason: string }> = []
  const inserts: string[] = []
  installMock((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
    if (sql.includes('FROM auth_attempts') && sql.includes('COUNT')) {
      return { rows: [{ n: '0' }] }
    }
    if (sql.includes('FROM users') && sql.includes('LOWER(email)')) {
      assert.equal(params[0], 'newuser@dev.local')
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO users')) {
      inserts.push('users')
      assert.equal(params[1], 'newuser@dev.local')
      assert.equal(params[2], 'New User')
      assert.match(String(params[3]), /^scrypt:/)
      assert.equal(params[4], false)
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO companies')) {
      inserts.push('companies')
      assert.equal(params[1], "New User's workspace")
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO company_members')) {
      inserts.push('company_members')
      assert.match(sql, /role\) VALUES \(\$1, \$2, 'owner'\)/)
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO participants')) {
      inserts.push('participants')
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO auth_attempts')) {
      recorded.push({ success: Boolean(params[2]), reason: String(params[3]) })
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordSignup({
    email: 'NewUser@dev.local',
    password: 'super-secret',
    displayName: 'New User',
    ip: '127.0.0.1',
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.match(result.userId, /^u-/)
    assert.equal(result.email, 'newuser@dev.local')
    assert.equal(result.displayName, 'New User')
    assert.match(result.companyId, /^co-/)
  }
  assert.deepEqual(inserts, ['users', 'companies', 'company_members', 'participants'])
  assert.deepEqual(recorded, [{ success: true, reason: 'signup_ok' }])
})

test('attemptPasswordSignup: inviteToken skips personal company', async () => {
  const recorded: Array<{ success: boolean; reason: string }> = []
  const inserts: string[] = []
  installMock((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
    if (sql.includes('FROM auth_attempts') && sql.includes('COUNT')) {
      return { rows: [{ n: '0' }] }
    }
    if (sql.includes('FROM users') && sql.includes('LOWER(email)')) {
      assert.equal(params[0], 'invitee@dev.local')
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO users')) {
      inserts.push('users')
      assert.equal(params[1], 'invitee@dev.local')
      assert.equal(params[2], 'Invitee')
      assert.match(String(params[3]), /^scrypt:/)
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO companies') || sql.includes('INSERT INTO company_members') || sql.includes('INSERT INTO participants')) {
      throw new Error(`invite path must not create a personal workspace: ${sql}`)
    }
    if (sql.includes('INSERT INTO auth_attempts')) {
      recorded.push({ success: Boolean(params[2]), reason: String(params[3]) })
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordSignup({
    email: 'Invitee@dev.local',
    password: 'super-secret',
    displayName: 'Invitee',
    ip: '127.0.0.1',
    inviteToken: 'invite-token-abc',
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.match(result.userId, /^u-/)
    assert.equal(result.email, 'invitee@dev.local')
    assert.equal(result.displayName, 'Invitee')
    assert.equal(result.companyId, null)
  }
  assert.deepEqual(inserts, ['users'])
  assert.deepEqual(recorded, [{ success: true, reason: 'signup_ok' }])
})

test('attemptPasswordSignup: duplicate email → 409', async () => {
  installMock((sql, params) => {
    if (sql.includes('FROM auth_attempts') && sql.includes('COUNT')) {
      return { rows: [{ n: '0' }] }
    }
    if (sql.includes('FROM users') && sql.includes('LOWER(email)')) {
      return { rows: [{ id: 'u-existing' }] }
    }
    if (sql.includes('INSERT INTO auth_attempts')) {
      assert.equal(params[2], false)
      assert.equal(params[3], 'email_taken')
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordSignup({
    email: 'taken@dev.local',
    password: 'super-secret',
    ip: '127.0.0.1',
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'email_taken')
    assert.equal(result.status, 409)
  }
})

test('attemptPasswordSignup: short password → 400', async () => {
  const recorded: Array<{ success: boolean; reason: string }> = []
  installMock((sql, params) => {
    if (sql.includes('INSERT INTO auth_attempts')) {
      recorded.push({ success: Boolean(params[2]), reason: String(params[3]) })
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordSignup({
    email: 'short@dev.local',
    password: '1234567',
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'short_password')
    assert.equal(result.status, 400)
  }
  assert.deepEqual(recorded, [{ success: false, reason: 'short_password' }])
})
