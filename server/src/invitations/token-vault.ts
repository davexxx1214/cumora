import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const FORMAT = 'v1'
const IV_BYTES = 12

function keyFromSecret(secret: string): Buffer {
  if (!secret.trim()) throw new Error('invite token encryption secret is empty')
  return createHash('sha256')
    .update('cumora:invite-token:v1\0')
    .update(secret)
    .digest()
}

function aad(companyId: string, tokenHash: string): Buffer {
  return Buffer.from(`${companyId}\0${tokenHash}`, 'utf8')
}

/** Encrypt a raw invitation token for owner/admin re-copy. The token hash
 * remains the public lookup key; AES-GCM keeps a database-only leak from
 * yielding usable invitation URLs. */
export function sealInviteToken(args: {
  token: string
  companyId: string
  tokenHash: string
  secret: string
}): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(args.secret), iv)
  cipher.setAAD(aad(args.companyId, args.tokenHash))
  const ciphertext = Buffer.concat([cipher.update(args.token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [FORMAT, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

/** Best-effort decrypt for list responses. Null means legacy row, key
 * rotation, malformed data, or failed authentication; callers can offer
 * an explicit token rotation without weakening invite validation. */
export function openInviteToken(args: {
  sealed: string | null | undefined
  companyId: string
  tokenHash: string
  secret: string
}): string | null {
  if (!args.sealed) return null
  try {
    const [format, ivPart, tagPart, ciphertextPart, extra] = args.sealed.split('.')
    if (format !== FORMAT || !ivPart || !tagPart || !ciphertextPart || extra) return null
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFromSecret(args.secret),
      Buffer.from(ivPart, 'base64url'),
    )
    decipher.setAAD(aad(args.companyId, args.tokenHash))
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

