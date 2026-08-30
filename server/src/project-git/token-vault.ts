import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const FORMAT = 'v1'
const IV_BYTES = 12

function keyFromSecret(secret: string): Buffer {
  if (!secret.trim()) throw new Error('Git credential encryption secret is empty')
  return createHash('sha256').update('cumora:git-credential:v1\0').update(secret).digest()
}

function aad(companyId: string, credentialId: string): Buffer {
  return Buffer.from(`${companyId}\0${credentialId}`, 'utf8')
}

export function sealGitToken(args: { token: string; companyId: string; credentialId: string; secret: string }): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(args.secret), iv)
  cipher.setAAD(aad(args.companyId, args.credentialId))
  const ciphertext = Buffer.concat([cipher.update(args.token, 'utf8'), cipher.final()])
  return [FORMAT, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function openGitToken(args: { sealed: string; companyId: string; credentialId: string; secret: string }): string | null {
  try {
    const [format, iv, tag, ciphertext, extra] = args.sealed.split('.')
    if (format !== FORMAT || !iv || !tag || !ciphertext || extra) return null
    const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(args.secret), Buffer.from(iv, 'base64url'))
    decipher.setAAD(aad(args.companyId, args.credentialId))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch { return null }
}
