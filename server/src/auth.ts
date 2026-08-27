/**
 * Auth primitives — session tokens, password login, gravatar, audit log,
 * WS tickets, Express middleware. Identity comes from OAuth (Google /
 * GitHub / Apple — see oauth.ts) OR local email+password (self-hosted).
 * No native deps; everything is Node stdlib.
 *
 * Threat model:
 *  - DB compromise: session/ws-ticket tokens are stored as sha256(token);
 *    the raw token is only held in memory + on the wire, so a DB leak
 *    does NOT yield usable session tokens (assuming sha256 preimage is hard).
 *    Passwords are stored as scrypt digests (see password.ts) — never plaintext.
 *  - Token sniffing: tokens travel as Authorization headers; HTTPS-only in
 *    prod is the deploy-side responsibility.
 *  - CSRF: tokens are sent via Authorization header (not cookies), so no
 *    cross-origin form auto-submit can carry them.
 *  - Identity binding: OAuth provider attests to email ownership. Local
 *    password login/signup is additive for self-hosted deploys without OAuth;
 *    rate-limited via auth_attempts and compared in constant-ish time.
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { pool } from './db/pool.js'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.js'

/** Generate a fresh 256-bit URL-safe session token. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hash a token for at-rest storage. The DB only ever sees this digest;
 *  the raw token is what we hand back to the client. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/**
 * Derive a Gravatar avatar URL from an email. Uses Gravatar's standard
 * "lowercase-trim-md5" key. `d=identicon` makes Gravatar generate a
 * deterministic geometric avatar when the user hasn't claimed the email,
 * so every human gets SOMETHING visual without us paying for an upload.
 *
 * `s=256` requests a 256px PNG — enough resolution for the largest avatar
 * surface in the app (88px InfoPane header @ 2x DPR ≈ 176, with margin).
 */
export function gravatarUrlForEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  const md5 = createHash('md5').update(normalized).digest('hex')
  return `https://www.gravatar.com/avatar/${md5}?d=identicon&s=256`
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30  // 30 days hard cap
/** Idle expiry — sessions unused for this long are also rejected, even if
 *  their hard expires_at hasn't passed. Limits the blast radius of a
 *  stolen but stale token. */
const SESSION_IDLE_TTL_MS = 1000 * 60 * 60 * 24 * 14  // 14 days idle

/** Create a session row and return the raw token. */
export async function createSession(userId: string, opts: { ip?: string; ua?: string }): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), userId, expiresAt, opts.ip ?? null, opts.ua ?? null],
  )
  await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId])
  return { token, expiresAt }
}

/** Look up an active session by token, sliding-update last_used_at.
 *  Rejects on hard expiry OR idle expiry OR account suspension (whichever
 *  hits first). The JOIN onto `users` is the suspension gate — we don't
 *  trust just-the-session being valid; the user behind it has to be
 *  un-suspended too. This adds one row's worth of work per request and is
 *  the only correct place to put the check (per-route checks would leave
 *  WS / runtime / inbound-email paths open). */
export async function resolveSession(token: string): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(token)
  const { rows } = await pool.query<{
    user_id: string; expires_at: string; last_used_at: string
    suspended_at: string | null; deleted_at: string | null
  }>(
    `SELECT s.user_id, s.expires_at, s.last_used_at, u.suspended_at, u.deleted_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  )
  if (!rows[0]) return null
  const now = Date.now()
  const expired = new Date(rows[0].expires_at).getTime() < now
  const idle = new Date(rows[0].last_used_at).getTime() < now - SESSION_IDLE_TTL_MS
  if (expired || idle) {
    await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash])
    return null
  }
  if (rows[0].suspended_at || rows[0].deleted_at) {
    // Defense in depth. suspendUser / deleteAccount already DELETE
    // every session row for this user as part of the same
    // transaction, but the small window between "stamp the column"
    // and "delete sessions" — plus any session minted by an
    // in-flight OAuth callback racing the operation — could
    // otherwise sneak past. Reject here too.
    // We do NOT delete the session row in this code path: the
    // sessions table is a write-heavy hot path and we don't want
    // every read of a stale token to fan out into a write. The
    // cleanup already happened (or is happening) atomically.
    return null
  }
  void pool.query(`UPDATE sessions SET last_used_at = NOW() WHERE token_hash = $1`, [tokenHash])
  return { userId: rows[0].user_id }
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)])
}

/* ============== Local email + password login ============== */

/** Sliding window used by /auth/login rate limits. */
const AUTH_ATTEMPT_WINDOW_MS = 15 * 60_000
/** Max failed attempts for one email inside the window before lockout. */
const AUTH_MAX_FAILURES_EMAIL = 10
/** Max failed attempts from one IP inside the window (covers spray). */
const AUTH_MAX_FAILURES_IP = 40

export type PasswordLoginFailReason =
  | 'bad_password'
  | 'unknown_email'
  | 'locked'
  | 'no_password'
  | 'suspended'
  | 'deleted'

export type PasswordLoginResult =
  | { ok: true; userId: string; email: string; displayName: string }
  | { ok: false; reason: PasswordLoginFailReason; status: 401 | 403 | 429 }

async function countRecentFailures(opts: { email?: string; ip?: string | null }): Promise<number> {
  if (opts.email) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM auth_attempts
        WHERE email = $1 AND success = false
          AND created_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
      [opts.email, AUTH_ATTEMPT_WINDOW_MS],
    )
    return Number(rows[0]?.n ?? '0')
  }
  if (opts.ip) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM auth_attempts
        WHERE ip = $1 AND success = false
          AND created_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
      [opts.ip, AUTH_ATTEMPT_WINDOW_MS],
    )
    return Number(rows[0]?.n ?? '0')
  }
  return 0
}

async function recordAuthAttempt(args: {
  email: string | null
  ip: string | null
  success: boolean
  reason: string
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO auth_attempts (email, ip, success, reason) VALUES ($1, $2, $3, $4)`,
      [args.email, args.ip, args.success, args.reason],
    )
  } catch (e) {
    console.warn('[auth] auth_attempts write failed', e)
  }
}

/**
 * Verify email+password and return the user id on success. Does NOT mint a
 * session — the caller (router) does that via createSession so the response
 * shape stays identical to OAuth. Records every attempt in auth_attempts.
 */
export async function attemptPasswordLogin(args: {
  email: string
  password: string
  ip?: string | null
}): Promise<PasswordLoginResult> {
  const email = args.email.trim().toLowerCase()
  const ip = args.ip ?? null
  if (!email || !args.password) {
    await recordAuthAttempt({ email: email || null, ip, success: false, reason: 'bad_password' })
    return { ok: false, reason: 'bad_password', status: 401 }
  }

  // Rate limit before touching the users table so a locked account isn't
  // a free oracle for "does this email exist".
  const emailFails = await countRecentFailures({ email })
  if (emailFails >= AUTH_MAX_FAILURES_EMAIL) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'locked' })
    return { ok: false, reason: 'locked', status: 429 }
  }
  if (ip) {
    const ipFails = await countRecentFailures({ ip })
    if (ipFails >= AUTH_MAX_FAILURES_IP) {
      await recordAuthAttempt({ email, ip, success: false, reason: 'locked' })
      return { ok: false, reason: 'locked', status: 429 }
    }
  }

  const { rows } = await pool.query<{
    id: string
    email: string
    display_name: string
    password_hash: string | null
    suspended_at: string | null
    deleted_at: string | null
  }>(
    `SELECT id, email, display_name, password_hash, suspended_at, deleted_at
       FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email],
  )
  const user = rows[0]
  if (!user) {
    // Burn the same scrypt work as a real verify so timing doesn't leak
    // whether the email is registered.
    await verifyPassword(args.password, DUMMY_PASSWORD_HASH)
    await recordAuthAttempt({ email, ip, success: false, reason: 'unknown_email' })
    return { ok: false, reason: 'unknown_email', status: 401 }
  }
  if (user.deleted_at) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'deleted' })
    return { ok: false, reason: 'deleted', status: 401 }
  }
  if (user.suspended_at) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'suspended' })
    return { ok: false, reason: 'suspended', status: 403 }
  }
  if (!user.password_hash) {
    // OAuth-only account — treat like a bad password so we don't advertise
    // "this email exists but has no password".
    await verifyPassword(args.password, DUMMY_PASSWORD_HASH)
    await recordAuthAttempt({ email, ip, success: false, reason: 'no_password' })
    return { ok: false, reason: 'no_password', status: 401 }
  }

  const ok = await verifyPassword(args.password, user.password_hash)
  if (!ok) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'bad_password' })
    return { ok: false, reason: 'bad_password', status: 401 }
  }

  await recordAuthAttempt({ email, ip, success: true, reason: 'ok' })
  return {
    ok: true,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
  }
}

/* ============== Local email + password signup ============== */

/** Minimum password length accepted by POST /auth/signup. */
export const MIN_PASSWORD_LENGTH = 8

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type PasswordSignupFailReason =
  | 'invalid_email'
  | 'short_password'
  | 'email_taken'
  | 'locked'
  | 'waitlisted'

export type PasswordSignupResult =
  | { ok: true; userId: string; email: string; displayName: string; companyId: string | null }
  | { ok: false; reason: PasswordSignupFailReason; status: 400 | 403 | 409 | 429 }

/**
 * Create a local email+password user + (usually) a personal company. Does NOT
 * mint a session — the caller (router) does that via createSession so the
 * response shape stays identical to login / OAuth. Rate-limited via auth_attempts.
 *
 * Personal-workspace creation is GATED on `inviteToken`: if signup started
 * from /invite/<token>, the user is here to join someone else's workspace —
 * auto-creating their own would leave a stray "Their Name's workspace" they
 * never wanted (matches OAuth Path C).
 *
 * Waitlist is a policy input (from the router) so this module doesn't import
 * admin.ts (cycle: admin → auth). Onboarding (starter agents, all-hands) is
 * likewise the router's job, matching OAuth Path C's post-commit helpers.
 */
export async function attemptPasswordSignup(args: {
  email: string
  password: string
  displayName?: string | null
  ip?: string | null
  waitlistEnabled?: boolean
  isAdmin?: boolean
  inviteToken?: string | null
}): Promise<PasswordSignupResult> {
  const email = args.email.trim().toLowerCase()
  const ip = args.ip ?? null
  const password = args.password
  if (!email || !EMAIL_RE.test(email)) {
    await recordAuthAttempt({ email: email || null, ip, success: false, reason: 'invalid_email' })
    return { ok: false, reason: 'invalid_email', status: 400 }
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'short_password' })
    return { ok: false, reason: 'short_password', status: 400 }
  }

  const displayName = (
    (typeof args.displayName === 'string' && args.displayName.trim())
      ? args.displayName.trim()
      : (email.split('@')[0] || email)
  ).slice(0, 80)

  const emailFails = await countRecentFailures({ email })
  if (emailFails >= AUTH_MAX_FAILURES_EMAIL) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'locked' })
    return { ok: false, reason: 'locked', status: 429 }
  }
  if (ip) {
    const ipFails = await countRecentFailures({ ip })
    if (ipFails >= AUTH_MAX_FAILURES_IP) {
      await recordAuthAttempt({ email, ip, success: false, reason: 'locked' })
      return { ok: false, reason: 'locked', status: 429 }
    }
  }

  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email],
  )
  if (existing[0]) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'email_taken' })
    return { ok: false, reason: 'email_taken', status: 409 }
  }

  if (args.waitlistEnabled && !args.isAdmin) {
    await recordAuthAttempt({ email, ip, success: false, reason: 'waitlisted' })
    return { ok: false, reason: 'waitlisted', status: 403 }
  }

  const passwordHash = await hashPassword(password)
  const userId = `u-${randomUUID().slice(0, 12)}`
  const avatar = gravatarUrlForEmail(email)
  const isAdmin = args.isAdmin === true
  const skipPersonalCompany = Boolean(args.inviteToken && args.inviteToken.trim())

  const client = await pool.connect()
  let companyId: string | null = null
  try {
    await client.query('BEGIN')
    try {
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, is_admin, tier, avatar_url)
           VALUES ($1, $2, $3, $4, $5, 'free', $6)`,
        [userId, email, displayName, passwordHash, isAdmin, avatar],
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/duplicate key/.test(msg)) {
        await client.query('ROLLBACK').catch(() => {})
        await recordAuthAttempt({ email, ip, success: false, reason: 'email_taken' })
        return { ok: false, reason: 'email_taken', status: 409 }
      }
      throw e
    }
    // Match OAuth Path C: if the flow started from /invite/<token>, create the
    // user only — no personal company, no company_members, no participants row.
    if (!skipPersonalCompany) {
      companyId = `co-${randomUUID().slice(0, 10)}`
      const slugSeed = (email.split('@')[0] || 'workspace').replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'workspace'
      let finalSlug = slugSeed
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.query(
            `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
            [companyId, `${displayName}'s workspace`, finalSlug, userId],
          )
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!/duplicate key/.test(msg)) throw e
          finalSlug = `${slugSeed}-${randomUUID().slice(0, 4)}`
        }
      }
      await client.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [companyId, userId],
      )
      await client.query(
        `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, avatar_url, status, company_id)
           VALUES ($1, 'human', $2, NULL, $3, '#FF8870', $4, 'avail', $5)
           ON CONFLICT (id, company_id) DO NOTHING`,
        [userId, displayName, displayName.charAt(0).toUpperCase(), avatar, companyId],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  await recordAuthAttempt({ email, ip, success: true, reason: 'signup_ok' })
  return { ok: true, userId, email, displayName, companyId }
}

/* ============== Audit log ============== */

export async function audit(args: {
  kind: string
  userId?: string | null
  companyId?: string | null
  ip?: string | null
  userAgent?: string | null
  detail?: Record<string, unknown>
}): Promise<void> {
  // Audit must never break the request path — fire-and-forget on failure.
  try {
    await pool.query(
      `INSERT INTO audit_events (user_id, company_id, ip, user_agent, kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        args.userId ?? null, args.companyId ?? null, args.ip ?? null,
        args.userAgent ?? null, args.kind,
        args.detail ? JSON.stringify(args.detail) : null,
      ],
    )
  } catch (e) {
    console.warn('[audit] write failed', e)
  }
}

/* ============== WebSocket short-lived tickets ============== */

const WS_TICKET_TTL_MS = 60_000  // 60 seconds — just enough for handshake

/** Mint a one-shot ticket for the WS handshake. Returns the RAW ticket
 *  (only stored hashed). Client puts this on the WS connect URL; server
 *  consumes it on connect. Never echo session tokens through the WS query. */
export async function createWsTicket(userId: string): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + WS_TICKET_TTL_MS)
  await pool.query(
    `INSERT INTO ws_tickets (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [hashToken(ticket), userId, expiresAt],
  )
  return { ticket, expiresAt }
}

/** Single-use consume — atomically marks the ticket used and returns userId.
 *  Refuses already-used, expired, or unknown tickets. */
export async function consumeWsTicket(ticket: string): Promise<{ userId: string } | null> {
  const hash = hashToken(ticket)
  const upd = await pool.query<{ user_id: string }>(
    `UPDATE ws_tickets SET used_at = NOW()
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       RETURNING user_id`,
    [hash],
  )
  if ((upd.rowCount ?? 0) === 0) return null
  return { userId: upd.rows[0].user_id }
}

/* ============== Express middleware ============== */

export interface AuthedRequest {
  /** Set by `authMiddleware` when a valid session is present. */
  authUserId?: string
}

/**
 * Reads `Authorization: Bearer <token>` (or `x-session-token` header for
 * websocket-style clients), looks up the session, attaches userId.
 * Does NOT itself reject — handlers / `requireAuth` decide if auth is needed.
 */
export async function authMiddleware(
  req: { headers: Record<string, string | string[] | undefined> } & AuthedRequest,
  _res: unknown,
  next: () => void,
): Promise<void> {
  let token: string | undefined
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) token = auth.slice(7).trim()
  if (!token) {
    const h = req.headers['x-session-token']
    if (typeof h === 'string') token = h.trim()
  }
  if (token) {
    const session = await resolveSession(token)
    if (session) req.authUserId = session.userId
  }
  next()
}
