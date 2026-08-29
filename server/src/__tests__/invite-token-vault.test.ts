import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openInviteToken, sealInviteToken } from '../invitations/token-vault.js'

const args = {
  token: 'raw-invite-token',
  companyId: 'co-one',
  tokenHash: 'hash-one',
  secret: 'test-secret-with-enough-entropy',
}

test('invite token vault round-trips without storing plaintext', () => {
  const sealed = sealInviteToken(args)
  assert.doesNotMatch(sealed, /raw-invite-token/)
  assert.equal(openInviteToken({ ...args, sealed }), args.token)
})

test('invite token vault rejects a different tenant, hash, key, or tampered ciphertext', () => {
  const sealed = sealInviteToken(args)
  assert.equal(openInviteToken({ ...args, sealed, companyId: 'co-two' }), null)
  assert.equal(openInviteToken({ ...args, sealed, tokenHash: 'hash-two' }), null)
  assert.equal(openInviteToken({ ...args, sealed, secret: 'different-secret' }), null)
  assert.equal(openInviteToken({ ...args, sealed: `${sealed.slice(0, -1)}A` }), null)
})

test('invite token vault treats missing and legacy values as unavailable', () => {
  assert.equal(openInviteToken({ ...args, sealed: null }), null)
  assert.equal(openInviteToken({ ...args, sealed: 'legacy-plaintext' }), null)
})

