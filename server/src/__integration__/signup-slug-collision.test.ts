/**
 * Personal-workspace slug collisions at signup (#102).
 *
 * This can only be proven against a real Postgres, because the bug IS a
 * Postgres behaviour: a unique violation aborts the entire transaction until
 * something rolls it back, so the retry that was supposed to pick a new slug
 * instead came back with "current transaction is aborted, commands ignored
 * until end of transaction block" — a message that is not a duplicate-key
 * error, so it escaped the retry and was thrown all the way to the browser.
 *
 * The collision is not between one user's two accounts. The slug is derived
 * from the email's local part and is unique across the whole deployment, so
 * every signup whose local part was already taken by ANY earlier user hit it.
 * Short, common local parts ("info", "me", "admin", a first name) make that
 * ordinary rather than unlucky.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { insertPersonalWorkspace, workspaceSlugSeed } from '../personal-workspace.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

/** A user row to own the workspace — `companies.owner_user_id` references it. */
async function seedUser(email: string): Promise<string> {
  const id = `u-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`,
    [id, email, email.split('@')[0]],
  )
  return id
}

/** Take a slug, exactly as an earlier signup would have. */
async function occupySlug(slug: string): Promise<void> {
  const owner = await seedUser(`${slug}-owner@earlier.example`)
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [`co-${randomUUID().slice(0, 10)}`, 'earlier workspace', slug, owner],
  )
}

test('a taken slug no longer aborts the signup transaction', async () => {
  // The reported failure, reduced to its mechanism. Before the fix this threw
  // `current transaction is aborted, commands ignored until end of transaction
  // block` — the exact text the reporter saw in their address bar.
  await occupySlug('info')

  const userId = await seedUser('info@example.com')
  const companyId = `co-${randomUUID().slice(0, 10)}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const slug = await insertPersonalWorkspace(client, {
      companyId, name: "Info's workspace", ownerUserId: userId, email: 'info@example.com',
    })
    // The transaction must still be USABLE afterwards — that is the whole
    // point. Signup does several more inserts (company_members, participants)
    // before it commits, and an aborted transaction would fail every one.
    await client.query(
      `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [companyId, userId],
    )
    await client.query('COMMIT')

    assert.notEqual(slug, 'info', 'the taken slug must not be reused')
    assert.match(slug, /^info-[0-9a-f]{4}$/)
  } finally {
    client.release()
  }

  const r = await pool.query(`SELECT slug FROM companies WHERE id = $1`, [companyId])
  assert.equal(r.rowCount, 1, 'the workspace row must have been committed')

  const m = await pool.query(`SELECT 1 FROM company_members WHERE company_id = $1`, [companyId])
  assert.equal(m.rowCount, 1, 'the statements after the collision must have run')
})

test('an uncontested slug is still the plain local part', async () => {
  // The retry must not change the common case: the first user named "erika"
  // keeps `erika`, not `erika-1f2c`.
  const userId = await seedUser('erika@example.com')
  const companyId = `co-${randomUUID().slice(0, 10)}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const slug = await insertPersonalWorkspace(client, {
      companyId, name: "Erika's workspace", ownerUserId: userId, email: 'erika@example.com',
    })
    await client.query('COMMIT')
    assert.equal(slug, 'erika')
  } finally {
    client.release()
  }
})

test('several signups on the same local part all succeed', async () => {
  // Sequential rather than concurrent on purpose: each one must see the
  // previous winner's slug and route around it. A single savepoint that was
  // released but not re-taken would pass the first collision and fail the
  // second.
  const seen = new Set<string>()
  for (let i = 0; i < 4; i++) {
    const email = `me@example${i}.com`
    const userId = await seedUser(email)
    const companyId = `co-${randomUUID().slice(0, 10)}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const slug = await insertPersonalWorkspace(client, {
        companyId, name: `me ${i}`, ownerUserId: userId, email,
      })
      await client.query('COMMIT')
      assert.ok(!seen.has(slug), `slug ${slug} handed out twice`)
      seen.add(slug)
    } finally {
      client.release()
    }
  }
  assert.equal(seen.size, 4)
  assert.ok(seen.has('me'), 'the first one should still get the bare slug')
})

test('a failure that is not a unique violation is raised as itself', async () => {
  // The retry exists for conflicts. Anything else — here a NOT NULL violation
  // on companies.name — must come straight back out, not be retried four more
  // times and then reported as a slug problem.
  const userId = await seedUser('notnull@example.com')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assert.rejects(
      () => insertPersonalWorkspace(client, {
        companyId: `co-${randomUUID().slice(0, 10)}`,
        name: null as unknown as string,
        ownerUserId: userId,
        email: 'notnull@example.com',
      }),
      (e: Error & { code?: string }) => e.code === '23502' && !/could not allocate/.test(e.message),
    )
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
})

test('an exhausted retry names the constraint that actually kept losing', async () => {
  // Every retry changes only the SLUG, so a conflict on a different unique
  // index can never be retried away. When that happens the error has to say
  // so — "could not allocate a slug" alone would send the reader after the
  // wrong problem for a second time.
  const userId = await seedUser('dup@example.com')
  const companyId = `co-${randomUUID().slice(0, 10)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, 'taken', $2, $3)`,
    [companyId, `already-${randomUUID().slice(0, 6)}`, userId],
  )

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assert.rejects(
      // Same id as the row above: the conflict is on companies_pkey, and no
      // amount of new slugs will move it.
      () => insertPersonalWorkspace(client, {
        companyId, name: 'dup', ownerUserId: userId, email: 'dup@example.com',
      }),
      (e: Error) => /could not allocate a workspace slug/.test(e.message)
        && /companies_pkey/.test(e.message),
    )
    // And the transaction is still alive: each attempt rolled back to its own
    // savepoint, so the caller can still report the failure cleanly.
    const ping = await client.query('SELECT 1 AS ok')
    assert.equal(ping.rows[0].ok, 1)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
})

test('the slug seed is unchanged for the shapes that already exist', () => {
  // Existing workspaces keep the slugs they were given, so this derivation is
  // frozen — including its quirks (it does not lowercase, so an uppercase
  // local part becomes dashes).
  assert.equal(workspaceSlugSeed('info@example.com'), 'info')
  assert.equal(workspaceSlugSeed('first.last@example.com'), 'first-last')
  assert.equal(workspaceSlugSeed('a+b@example.com'), 'a-b')
  assert.equal(workspaceSlugSeed('@example.com'), 'workspace')
  // An all-punctuation local part collapses to a bare '-' rather than the
  // 'workspace' fallback, because '-' is truthy. Odd, but it is what existing
  // workspaces were slugged with, so it stays.
  assert.equal(workspaceSlugSeed('...@example.com'), '-')
  assert.equal(workspaceSlugSeed(`${'x'.repeat(50)}@example.com`), 'x'.repeat(30))
})
