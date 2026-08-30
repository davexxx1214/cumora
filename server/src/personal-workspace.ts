/**
 * Creating a user's personal workspace — the `companies` row plus a slug that
 * is unique across the deployment.
 *
 * This lives in one module because the two paths that do it had drifted apart,
 * and the drift WAS the bug (#102). Admin waitlist approval hit slug collisions
 * first (bulk approval retries short local-parts like "info" and "me" back to
 * back), was given a SAVEPOINT, and got a comment explaining why. OAuth signup
 * — the path every single user takes — kept the version without one. One
 * shared implementation is what stops the next fix landing on only one of them.
 */
import { randomUUID } from 'node:crypto'

/** Attempts before we give up on finding a free slug. Each retry appends 4 hex
 *  characters, so reaching the end means something other than bad luck. */
const MAX_SLUG_ATTEMPTS = 5

/** Postgres `unique_violation`.
 *
 *  Checked by SQLSTATE rather than by matching "duplicate key" in the message:
 *  that text comes from the server and is translated when `lc_messages` is not
 *  English, which would turn a recoverable collision into a hard signup
 *  failure on exactly the deployments least able to diagnose it. The message
 *  test stays as a fallback for drivers that surface an error without a code. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (code === '23505') return true
  return /duplicate key/i.test(e instanceof Error ? e.message : String(e))
}

/** The constraint a unique violation actually named, when the driver reports
 *  one. Only used to explain an exhausted retry — deliberately NOT used to
 *  decide whether to retry, because narrowing the retry to `companies_slug_key`
 *  would reintroduce #102 on any deployment that renamed the constraint. */
function violatedConstraint(e: unknown): string | null {
  const c = (e as { constraint?: unknown } | null)?.constraint
  return typeof c === 'string' && c ? c : null
}

/** The slug a personal workspace starts from: the email's local part, reduced
 *  to the characters a slug may contain. Unchanged from what both call sites
 *  did inline — existing workspaces must keep the slugs they already have. */
export function workspaceSlugSeed(email: string): string {
  return (email.split('@')[0] || 'workspace').replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'workspace'
}

/**
 * INSERT the personal workspace, retrying on slug collision. Returns the slug
 * that was actually taken. Must be called inside an open transaction.
 */
export async function insertPersonalWorkspace(
  client: import('pg').PoolClient,
  args: { companyId: string; name: string; ownerUserId: string; email: string },
): Promise<string> {
  const seed = workspaceSlugSeed(args.email)
  let slug = seed
  let lastConflict: unknown = null
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    // SAVEPOINT per attempt, and it is load-bearing. A unique violation aborts
    // the ENTIRE transaction until something rolls it back, so a bare retry
    // does not get a second shot at the slug: it fails with "current
    // transaction is aborted, commands ignored until end of transaction
    // block". That is not a duplicate-key error, so it escapes the retry and
    // is thrown — which is how ONE taken slug turned every later signup with
    // the same local part into a hard "Sign-in failed" (#102).
    await client.query('SAVEPOINT personal_workspace')
    try {
      await client.query(
        `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
        [args.companyId, args.name, slug, args.ownerUserId],
      )
      await client.query('RELEASE SAVEPOINT personal_workspace')
      return slug
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
      lastConflict = e
      await client.query('ROLLBACK TO SAVEPOINT personal_workspace')
      slug = `${seed}-${randomUUID().slice(0, 4)}`
    }
  }
  // Running out used to fall through silently, leaving companyId pointing at no
  // row — so a later statement failed on something unrelated and the operator
  // was handed the wrong problem to solve.
  //
  // Name the constraint that actually kept losing. Every retry only changes the
  // SLUG, so if the conflict was on some other unique index (a `companies_pkey`
  // id collision, say) then five more attempts were never going to help, and
  // saying "could not allocate a slug" would send the reader down the wrong
  // path a second time.
  const on = violatedConstraint(lastConflict)
  throw new Error(
    `could not allocate a workspace slug from "${seed}" after ${MAX_SLUG_ATTEMPTS} attempts` +
    (on ? ` (last conflict was on ${on})` : ''),
  )
}
