/**
 * Concurrent membership changes must not lose each other.
 *
 * `conversations.members` is a jsonb array, and every mutation of it read the
 * array, edited it in JavaScript, and wrote the whole thing back. Two of those
 * overlapping means the second write is computed from a snapshot taken before
 * the first, so the first change is silently erased.
 *
 * This is a hot path here rather than a theoretical one: the scheduler wakes
 * several agents for the same message, and `cumora invite` / `leave` / `kick`
 * are things those agents do in response. Concurrency is the normal case.
 *
 * The dropped invite is worse than it first looks. The `joined` system row is
 * posted regardless, so the transcript records a join that did not happen —
 * and because the mailbox query filters on `members @> [agentId]`, the agent
 * who "joined" is never woken for that conversation again. Nothing errors.
 *
 * Only a real Postgres can show this: it is about what two overlapping
 * statements do to one row.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { runCli } from '../agents/cli.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

async function seedAgent(companyId: string, id: string): Promise<string> {
  await seedCompanyWithAgent({ companyId, agentId: id })
  return id
}

async function seedGroup(companyId: string, members: string[]): Promise<string> {
  const convoId = `conv-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1, $2, 'group', 'race', $3::jsonb)`,
    [convoId, companyId, JSON.stringify(members)],
  )
  return convoId
}

async function membersOf(convoId: string): Promise<string[]> {
  const { rows } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = $1`, [convoId],
  )
  return rows[0]?.members ?? []
}

test('[integration] simultaneous invites do not lose an invitee', async () => {
  // Eight at once rather than two: a single overlapping pair only sometimes
  // interleaves inside the read→write window on a local socket, and a test
  // that passes on the broken code proves nothing. With eight, a
  // last-write-wins array loses several every run.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const host = await seedAgent(companyId, 'agent-host')
  const invitees = await Promise.all(
    Array.from({ length: 8 }, (_, i) => seedAgent(companyId, `agent-i${i}`)),
  )
  const convo = await seedGroup(companyId, [host])

  const results = await Promise.all(
    invitees.map((who) => runCli(['--as', host, 'invite', convo, who])),
  )
  for (const [i, r] of results.entries()) {
    assert.equal(r.ok, true, `invite ${invitees[i]} failed: ${r.text}`)
  }

  // Every invite reported success, so every invitee must actually be a member.
  // Before the fix several were missing while their `joined` rows still stood,
  // and their mailbox query (members @> [id]) never matched again.
  const members = await membersOf(convo)
  const missing = invitees.filter((who) => !members.includes(who))
  assert.deepEqual(missing, [], `dropped despite reporting success: ${JSON.stringify(missing)}`)
  assert.equal(new Set(members).size, members.length, `duplicate members: ${JSON.stringify(members)}`)
})

test('[integration] a leave that overlaps an invite keeps both effects', async () => {
  // The worst ordering: whoever writes last resurrects or erases the other.
  // Either the leaver is put back into a conversation they left, or the
  // invitee never lands — both leave the transcript disagreeing with the row.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const b = await seedAgent(companyId, 'agent-b')
  const x = await seedAgent(companyId, 'agent-x')
  const convo = await seedGroup(companyId, [a, b])

  const [leave, invite] = await Promise.all([
    runCli(['--as', a, 'leave', convo]),
    runCli(['--as', b, 'invite', convo, x]),
  ])
  assert.equal(leave.ok, true, `leave failed: ${leave.text}`)
  assert.equal(invite.ok, true, `invite failed: ${invite.text}`)

  const members = await membersOf(convo)
  assert.ok(!members.includes(a), `${a} left but is still a member: ${JSON.stringify(members)}`)
  assert.ok(members.includes(x), `${x} was invited but is not a member: ${JSON.stringify(members)}`)
  assert.ok(members.includes(b))
})

test('[integration] concurrent kicks of different agents both take effect', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const b = await seedAgent(companyId, 'agent-b')
  const x = await seedAgent(companyId, 'agent-x')
  const y = await seedAgent(companyId, 'agent-y')
  const convo = await seedGroup(companyId, [a, b, x, y])

  const [kx, ky] = await Promise.all([
    runCli(['--as', a, 'kick', convo, x]),
    runCli(['--as', b, 'kick', convo, y]),
  ])
  assert.equal(kx.ok, true, `kick x failed: ${kx.text}`)
  assert.equal(ky.ok, true, `kick y failed: ${ky.text}`)

  const members = await membersOf(convo)
  assert.ok(!members.includes(x), `${x} survived the kick: ${JSON.stringify(members)}`)
  assert.ok(!members.includes(y), `${y} survived the kick: ${JSON.stringify(members)}`)
  assert.deepEqual([...members].sort(), [a, b].sort())
})

test('[integration] inviting the same agent twice at once adds them once', async () => {
  // The "already a member" guard reads a snapshot, so both callers can pass it.
  // The write itself has to be what refuses the duplicate.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const b = await seedAgent(companyId, 'agent-b')
  const x = await seedAgent(companyId, 'agent-x')
  const convo = await seedGroup(companyId, [a, b])

  await Promise.all([
    runCli(['--as', a, 'invite', convo, x]),
    runCli(['--as', b, 'invite', convo, x]),
  ])

  const members = await membersOf(convo)
  assert.equal(members.filter((m) => m === x).length, 1, `${x} added twice: ${JSON.stringify(members)}`)
})

test('[integration] a lone sequential invite still behaves exactly as before', async () => {
  // The uncontended path is the one every user actually hits; the atomic
  // rewrite must not change it.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const x = await seedAgent(companyId, 'agent-x')
  const convo = await seedGroup(companyId, [a])

  const invited = await runCli(['--as', a, 'invite', convo, x])
  assert.equal(invited.ok, true, invited.text)
  assert.deepEqual(await membersOf(convo), [a, x])

  const kicked = await runCli(['--as', a, 'kick', convo, x, '--confirm-empty'])
  assert.equal(kicked.ok, true, kicked.text)
  assert.deepEqual(await membersOf(convo), [a])
})
