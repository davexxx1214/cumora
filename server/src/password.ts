/**
 * Password hashing — scrypt via Node crypto (no native deps).
 *
 * On-disk format: `scrypt:<salt-base64>:<derived-base64>`
 * Self-describing so a future algo upgrade can coexist during migration.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

/** scrypt key length (bytes). */
const KEYLEN = 64
/** Fresh salt length (bytes). */
const SALTLEN = 16

/** Hash a plaintext password for at-rest storage. Never store plaintext. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALTLEN)
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`
}

/**
 * Constant-ish-time compare of a plaintext password against a stored hash.
 * Returns false for malformed / unknown schemes rather than throwing —
 * callers treat that the same as a wrong password.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[1], 'base64')
    expected = Buffer.from(parts[2], 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/**
 * A fixed dummy hash used to burn roughly the same CPU as a real verify
 * when the email is unknown — blunts timing oracles that distinguish
 * "no such user" from "bad password".
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
