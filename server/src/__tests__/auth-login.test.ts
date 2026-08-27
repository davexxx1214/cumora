/**
 * Unit tests for local email+password login (attemptPasswordLogin).
 * Mocks pool.query — no live Postgres required.
 *
 * Run: node --import tsx --test server/src/__tests__/auth-login.test.ts
 */
import { test, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENAI_API_KEY ??= 'test-key'

const { pool } = await import('../db/pool.js')
const { hashPassword } = await import('../password.js')
const { attemptPasswordLogin } = await import('../auth.js')

type PoolQueryFn = typeof pool.query
const savedQuery = pool.query

afterEach(() => {
  ;(pool as unknown as { query: PoolQueryFn }).query = savedQuery
})

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
})

function installMock(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  ;(pool as unknown as { query: PoolQueryFn }).query = (async (sql: string, params: unknown[] = []) => {
    return handler(sql, params)
  }) as unknown as PoolQueryFn
}

test('attemptPasswordLogin: success with correct password', async () => {
  const passwordHash = await hashPassword('cumora-dev')
  const recorded: Array<{ success: boolean; reason: string }> = []
  installMock((sql, params) => {
    if (sql.includes('FROM auth_attempts') && sql.includes('COUNT')) {
      return { rows: [{ n: '0' }] }
    }
    if (sql.includes('FROM users') && sql.includes('LOWER(email)')) {
      assert.equal(params[0], 'davexxx1214@dev.local')
      return {
        rows: [{
          id: 'davexxx1214',
          email: 'davexxx1214@dev.local',
          display_name: 'davexxx1214',
          password_hash: passwordHash,
          suspended_at: null,
          deleted_at: null,
        }],
      }
    }
    if (sql.includes('INSERT INTO auth_attempts')) {
      recorded.push({ success: Boolean(params[2]), reason: String(params[3]) })
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordLogin({
    email: 'Davexxx1214@dev.local',
    password: 'cumora-dev',
    ip: '127.0.0.1',
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.userId, 'davexxx1214')
    assert.equal(result.email, 'davexxx1214@dev.local')
    assert.equal(result.displayName, 'davexxx1214')
  }
  assert.deepEqual(recorded, [{ success: true, reason: 'ok' }])
})

test('attemptPasswordLogin: bad password → 401', async () => {
  const passwordHash = await hashPassword('cumora-dev')
  installMock((sql, params) => {
    if (sql.includes('FROM auth_attempts') && sql.includes('COUNT')) {
      return { rows: [{ n: '0' }] }
    }
    if (sql.includes('FROM users')) {
      return {
        rows: [{
          id: 'davexxx1214',
          email: 'davexxx1214@dev.local',
          display_name: 'davexxx1214',
          password_hash: passwordHash,
          suspended_at: null,
          deleted_at: null,
        }],
      }
    }
    if (sql.includes('INSERT INTO auth_attempts')) {
      assert.equal(params[2], false)
      assert.equal(params[3], 'bad_password')
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordLogin({
    email: 'davexxx1214@dev.local',
    password: 'wrong',
    ip: '127.0.0.1',
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'bad_password')
    assert.equal(result.status, 401)
  }
})

test('attemptPasswordLogin: unknown user → 401 (same shape as bad password)', async () => {
  installMock((sql, params) => {
    if (sql.includes('FROM auth_attempts') && sql.includes('COUNT')) {
      return { rows: [{ n: '0' }] }
    }
    if (sql.includes('FROM users')) {
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO auth_attempts')) {
      assert.equal(params[3], 'unknown_email')
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordLogin({
    email: 'nobody@dev.local',
    password: 'whatever',
    ip: '127.0.0.1',
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'unknown_email')
    assert.equal(result.status, 401)
  }
})

test('attemptPasswordLogin: oauth-only account (null password_hash) → 401', async () => {
  installMock((sql) => {
    if (sql.includes('FROM auth_attempts') && sql.includes('COUNT')) {
      return { rows: [{ n: '0' }] }
    }
    if (sql.includes('FROM users')) {
      return {
        rows: [{
          id: 'u-oauth',
          email: 'oauth@example.com',
          display_name: 'OAuth User',
          password_hash: null,
          suspended_at: null,
          deleted_at: null,
        }],
      }
    }
    if (sql.includes('INSERT INTO auth_attempts')) {
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const result = await attemptPasswordLogin({
    email: 'oauth@example.com',
    password: 'nope',
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'no_password')
    assert.equal(result.status, 401)
  }
})
