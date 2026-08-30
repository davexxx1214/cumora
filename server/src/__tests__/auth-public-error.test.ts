/**
 * What a failed sign-in is allowed to tell the user (#102).
 *
 * The callback handler used to put `e.message` straight into the redirect
 * fragment, so whatever went wrong was rendered on the sign-in screen and
 * parked in the browser's address bar and history. That is how a Postgres
 * transaction error became user-visible copy.
 *
 * The rule is allow-by-construction, and these tests exist to keep it that
 * way: a message we WROTE for a person passes through, everything else — in
 * particular anything new — does not.
 *
 * Run: node --import tsx --test server/src/__tests__/auth-public-error.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SignInError, publicSignInError } from '../auth-errors.js'

test('a message written for the user passes through', () => {
  // These are the account-state problems the user can actually act on: go and
  // verify your email, reactivate your account, widen the OAuth scope.
  for (const m of [
    'google account has no verified email',
    'github account has no verified email',
    'gitlab account is not active',
    'gitlab account has no confirmed email',
    'gitlab account exposes no email to read_user',
  ]) {
    assert.equal(publicSignInError(new SignInError(m)), m)
  }
})

test('the reported Postgres error never reaches the user', () => {
  const pg = new Error('current transaction is aborted, commands ignored until end of transaction block')
  assert.equal(publicSignInError(pg), 'signin_failed')
})

test('a provider response body is not put in the address bar either', () => {
  // `token exchange` failures interpolate the provider's raw body. Nobody
  // asked for that to be user-visible; it just was, because it was an Error.
  const leak = new Error('github token exchange 401: {"error":"incorrect_client_credentials"}')
  assert.equal(publicSignInError(leak), 'signin_failed')
})

test('an internal error nobody has classified yet is private by default', () => {
  // The point of allow-by-construction. A deny-list would have to be updated
  // every time a new failure mode appears; this does not.
  for (const e of [
    new Error('ECONNREFUSED 127.0.0.1:6379'),
    new TypeError('Cannot read properties of undefined'),
    Object.assign(new Error('duplicate key value violates unique constraint "users_pkey"'), { code: '23505' }),
    'a bare string someone threw',
    null,
    undefined,
    { message: 'an object shaped like an error' },
  ]) {
    assert.equal(publicSignInError(e), 'signin_failed')
  }
})

test('a subclass of SignInError still passes through', () => {
  // Nothing subclasses it today, but the check is instanceof, not a name
  // comparison — so a future refinement does not silently go private.
  class ProviderSignInError extends SignInError {}
  assert.equal(publicSignInError(new ProviderSignInError('nope')), 'nope')
})
