import { timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import { fail } from './model.js'

/** Shared only by this Linux API and its trusted computer daemon. General
 * Agent JWTs, browser sessions, and file leases cannot mint/stop leases. */
export function requireProjectHost(req: Request): void {
  const expected = process.env.CUMORA_PROJECT_HOST_SECRET ?? ''
  const supplied = req.headers['x-cumora-project-host']
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
  if (!local || expected.length < 32 || typeof supplied !== 'string' ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    fail('HOST_REQUIRED', 403, 'A configured local task supervisor is required.')
  }
}
