/**
 * Sign-in failure classification. Its own module, with no imports, so the unit
 * tests can pin the rule without booting env.ts / pool.ts / redis.ts — the
 * same reason cli-parse.ts is split out of cli.ts.
 */

/** A sign-in failure whose message was WRITTEN BY US for the user to read —
 *  "your GitHub account has no verified email", and its siblings. Everything
 *  the user can actually act on is one of these.
 *
 *  It exists so the callback handler can tell those apart from the failures it
 *  merely caught. That handler used to put `e.message` straight into the
 *  redirect fragment, which is how a Postgres transaction error ended up
 *  rendered on the sign-in screen (#102) — and, less visibly, how a provider's
 *  raw token-endpoint response body could be parked in the address bar too. */
export class SignInError extends Error {}

/** What a failed sign-in is allowed to tell the user.
 *
 *  Allow-by-construction: only a SignInError passes through, and everything
 *  else collapses to a fixed code. A deny-list would have to be extended every
 *  time a new failure mode appeared; this way an internal error introduced
 *  tomorrow is private on the day it is written rather than on the day
 *  somebody spots it in a screenshot.
 *
 *  `signin_failed` is a code rather than a sentence to match the two the same
 *  handler already emits (`bad_state`, `missing_code_or_state`); turning those
 *  codes into friendly copy is a renderer concern, not this function's. */
export function publicSignInError(e: unknown): string {
  return e instanceof SignInError ? e.message : 'signin_failed'
}
