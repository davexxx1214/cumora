/**
 * Regression coverage for request-body limits and authentication ordering.
 *
 * The API router must never parse the large base64 upload allowance before a
 * user session has been established. Ordinary/public API requests stay on a
 * much smaller ceiling, while authenticated uploads retain their larger
 * route-specific parser.
 */
import { createServer, type Server } from 'node:http'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import {
  ensureSchemaOnce,
  resetAllTables,
  seedUserMembership,
  teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'
import { createSession } from '../auth.js'

const USER_ID = 'body-auth-user'
const COMPANY_ID = 'body-auth-company'

let server: Server
let baseUrl = ''
let sessionToken = ''

before(async () => {
  await ensureSchemaOnce()
  const expressMod = await import('express')
  const express = expressMod.default
  const { api } = await import('../api/router.js')
  const app = express()
  app.use('/api', api)

  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing test address')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Body Auth Test', $2, $3)`,
    [COMPANY_ID, COMPANY_ID, USER_ID],
  )
  await seedUserMembership(USER_ID, COMPANY_ID)
  sessionToken = (await createSession(USER_ID, {})).token
})

after(async () => {
  await teardownAll(server)
})

async function postRaw(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
  return { status: response.status, body: await response.text() }
}

test('[integration] upload rejects an anonymous multi-megabyte body before parsing JSON', async () => {
  const response = await postRaw('/api/uploads', `{${'x'.repeat(1024 * 1024)}`)
  assert.equal(response.status, 401)
  assert.deepEqual(JSON.parse(response.body), { error: 'authentication required' })
})

test('[integration] authenticated upload retains its route-specific large JSON allowance', async () => {
  const response = await postRaw(
    '/api/uploads',
    JSON.stringify({
      name: 'probe.bin',
      mime: 'application/x-not-allowed',
      dataBase64: 'A'.repeat(300 * 1024),
    }),
    {
      authorization: `Bearer ${sessionToken}`,
      'x-company-id': COMPANY_ID,
    },
  )
  assert.equal(response.status, 415)
  assert.match(response.body, /mime not allowed/i)
})

test('[integration] an expired session rejects a large malformed upload before JSON parsing', async () => {
  await pool.query(
    `UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`,
    [USER_ID],
  )
  const response = await postRaw(
    '/api/uploads',
    `{${'x'.repeat(1024 * 1024)}`,
    { authorization: `Bearer ${sessionToken}` },
  )
  assert.equal(response.status, 401)
  assert.deepEqual(JSON.parse(response.body), { error: 'authentication required' })
})

test('[integration] ordinary anonymous API JSON is capped at 256KB', async () => {
  const response = await postRaw(
    '/api/auth/apple/native',
    JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
  )
  assert.equal(response.status, 413)
  assert.deepEqual(JSON.parse(response.body), { error: 'request entity too large' })
})

test('[integration] malformed ordinary JSON returns a stable 400 response', async () => {
  const response = await postRaw('/api/auth/apple/native', '{malformed')
  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid JSON body' })
})

test('[integration] unsupported JSON charset remains a stable 415 client error', async () => {
  const response = await postRaw('/api/auth/apple/native', '{}', {
    'content-type': 'application/json; charset=iso-8859-1',
  })
  assert.equal(response.status, 415)
  assert.deepEqual(JSON.parse(response.body), { error: 'unsupported request encoding' })
})

test('[integration] unsupported content encoding remains a stable 415 client error', async () => {
  const response = await postRaw('/api/auth/apple/native', '{}', {
    'content-encoding': 'x-unsupported',
  })
  assert.equal(response.status, 415)
  assert.deepEqual(JSON.parse(response.body), { error: 'unsupported request encoding' })
})
