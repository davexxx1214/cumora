/**
 * Unit tests for scrypt password hashing (no DB).
 *
 * Run: node --import tsx --test server/src/__tests__/password.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword } from '../password.js'

test('hashPassword returns scrypt:<salt>:<derived> and never stores plaintext', async () => {
  const hash = await hashPassword('cumora-dev')
  assert.match(hash, /^scrypt:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
  assert.equal(hash.includes('cumora-dev'), false)
})

test('verifyPassword accepts the matching plaintext', async () => {
  const hash = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('correct-horse', hash), true)
})

test('verifyPassword rejects a wrong password', async () => {
  const hash = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('wrong-password', hash), false)
})

test('verifyPassword rejects null / malformed stored hashes', async () => {
  assert.equal(await verifyPassword('x', null), false)
  assert.equal(await verifyPassword('x', undefined), false)
  assert.equal(await verifyPassword('x', 'not-a-hash'), false)
  assert.equal(await verifyPassword('x', 'bcrypt:foo:bar'), false)
})

test('two hashes of the same password use different salts', async () => {
  const a = await hashPassword('same')
  const b = await hashPassword('same')
  assert.notEqual(a, b)
  assert.equal(await verifyPassword('same', a), true)
  assert.equal(await verifyPassword('same', b), true)
})
