/**
 * Deterministic authorization races for Convene orchestration.
 *
 * The production LLM override is used only as a controllable Promise barrier:
 * the first speech request can be paused while a real membership kick commits.
 * Persisted transcript rows and Redis events still travel through production
 * code, so these tests cover both pre-generation and post-generation checks.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import IORedis from 'ioredis'
import { runCli } from '../agents/cli.js'
import { startConvene } from '../agents/convene.js'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { __setLlmClientOverrideForTesting } from '../llm.js'
import { CH_CONVENE } from '../redis.js'
import {
  ensureSchemaOnce, resetAllTables, seedCompanyWithAgent,
  seedUserMembership, teardownAll,
} from './_helpers.js'

interface FakeLlmRequest {
  input?: unknown
  text?: unknown
}

interface ConveneEvent {
  type?: string
  sessionId?: string
  conversationId?: string
  companyId?: string
  kind?: string
  data?: {
    id?: string
    authorId?: string
    body?: string
    kind?: string
  }
}

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  __setLlmClientOverrideForTesting(null)
  await resetAllTables()
})

after(async () => {
  __setLlmClientOverrideForTesting(null)
  await teardownAll()
})

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForSessionEnded(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt++) {
    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM convene_sessions WHERE id = $1`,
      [sessionId],
    )
    if (rows[0]?.state === 'ended') return
    await delay(10)
  }
  throw new Error(`convene session ${sessionId} did not end`)
}

async function waitForEvent(
  events: ConveneEvent[],
  predicate: (event: ConveneEvent) => boolean,
  label: string,
): Promise<ConveneEvent> {
  for (let attempt = 0; attempt < 800; attempt++) {
    const match = events.find(predicate)
    if (match) return match
    await delay(10)
  }
  throw new Error(`did not receive ${label}`)
}

function installFakeLlm(
  create: (request: FakeLlmRequest) => Promise<{ output_text: string; usage?: unknown }>,
): void {
  __setLlmClientOverrideForTesting((async () => ({
    responses: { create },
  })) as unknown as Parameters<typeof __setLlmClientOverrideForTesting>[0])
}

async function seedConvene(agentIds: string[]): Promise<{
  companyId: string
  starterId: string
  conversationId: string
}> {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  for (const agentId of agentIds) {
    await seedCompanyWithAgent({ companyId, agentId })
  }
  const starterId = `human-${randomUUID().slice(0, 8)}`
  await seedUserMembership(starterId, companyId, {
    email: `${starterId}@test.local`,
    displayName: `Starter ${starterId}`,
  })
  const conversationId = `conv-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1, $2, 'group', $3, $4::jsonb)`,
    [
      conversationId,
      companyId,
      `Convene ${conversationId}`,
      JSON.stringify([starterId, ...agentIds]),
    ],
  )
  return { companyId, starterId, conversationId }
}

function isSpeechRequest(request: FakeLlmRequest): boolean {
  return Array.isArray(request.input)
}

function moderatorLine(request: FakeLlmRequest): string {
  if (!Array.isArray(request.input)) return ''
  const last = request.input[request.input.length - 1] as { content?: unknown } | undefined
  return String(last?.content ?? '')
}

test('[integration] convene skips a queued second agent kicked while the first speech is paused', async () => {
  const firstAgentId = `agent-a-first-${randomUUID().slice(0, 6)}`
  const secondAgentId = `agent-z-second-${randomUUID().slice(0, 6)}`
  const seeded = await seedConvene([firstAgentId, secondAgentId])
  const firstEntered = signal()
  const releaseFirst = signal()
  const speechPrompts: string[] = []

  installFakeLlm(async (request) => {
    if (isSpeechRequest(request)) {
      const moderator = moderatorLine(request)
      speechPrompts.push(moderator)
      if (moderator.includes(firstAgentId)) {
        firstEntered.resolve()
        await releaseFirst.promise
        return { output_text: 'first agent contribution' }
      }
      return { output_text: 'second agent must never be called' }
    }
    return { output_text: JSON.stringify({ reached: false, headline: '', body: '' }) }
  })

  const session = await startConvene({
    conversationId: seeded.conversationId,
    companyId: seeded.companyId,
    startedBy: seeded.starterId,
    topic: 'membership revalidation before each turn',
  })
  let kick: Awaited<ReturnType<typeof runCli>>
  try {
    await withTimeout(firstEntered.promise, 'the first convene speech request')
    kick = await runCli([
      '--as', seeded.starterId, 'kick', seeded.conversationId, secondAgentId,
    ])
  } finally {
    releaseFirst.resolve()
  }
  assert.equal(kick!.ok, true, kick!.text)
  await withTimeout(waitForSessionEnded(session.id), 'the convene session to end')

  assert.equal(speechPrompts.length, 1, JSON.stringify(speechPrompts))
  assert.match(speechPrompts[0] ?? '', new RegExp(firstAgentId))
  assert.ok(!speechPrompts.some((prompt) => prompt.includes(secondAgentId)), 'kicked second agent reached the LLM')
  const { rows } = await pool.query<{ author_id: string; body: string }>(
    `SELECT author_id, body FROM convene_transcript
      WHERE session_id = $1 AND kind = 'text'
      ORDER BY sequence`,
    [session.id],
  )
  assert.deepEqual(rows, [{ author_id: firstAgentId, body: 'first agent contribution' }])
})

test('[integration] convene drops an agent result when the agent is kicked during generation', async () => {
  const agentId = `agent-generating-${randomUUID().slice(0, 6)}`
  const seeded = await seedConvene([agentId])
  const generationEntered = signal()
  const releaseGeneration = signal()
  let speechCalls = 0

  installFakeLlm(async (request) => {
    if (isSpeechRequest(request)) {
      speechCalls++
      generationEntered.resolve()
      await releaseGeneration.promise
      return { output_text: 'revoked result must not land' }
    }
    return { output_text: JSON.stringify({ reached: false, headline: '', body: '' }) }
  })

  const session = await startConvene({
    conversationId: seeded.conversationId,
    companyId: seeded.companyId,
    startedBy: seeded.starterId,
    topic: 'post-generation authorization',
  })
  let kick: Awaited<ReturnType<typeof runCli>>
  try {
    await withTimeout(generationEntered.promise, 'the in-flight convene generation')
    kick = await runCli([
      '--as', seeded.starterId, 'kick', seeded.conversationId, agentId, '--confirm-empty',
    ])
  } finally {
    releaseGeneration.resolve()
  }
  assert.equal(kick!.ok, true, kick!.text)
  await withTimeout(waitForSessionEnded(session.id), 'the convene session to end')

  assert.equal(speechCalls, 1)
  const { rows } = await pool.query<{ author_id: string; body: string }>(
    `SELECT author_id, body FROM convene_transcript WHERE session_id = $1`,
    [session.id],
  )
  assert.deepEqual(rows, [], 'a response generated after revocation reached the transcript')
})

test('[integration] convene transcript events carry the persisted conversation id', async () => {
  const agentId = `agent-event-${randomUUID().slice(0, 6)}`
  const seeded = await seedConvene([agentId])
  const subscriber = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  })
  const events: ConveneEvent[] = []
  subscriber.on('message', (channel, raw) => {
    if (channel !== CH_CONVENE) return
    try { events.push(JSON.parse(raw) as ConveneEvent) } catch { /* ignore unrelated malformed traffic */ }
  })
  await subscriber.subscribe(CH_CONVENE)

  installFakeLlm(async (request) => {
    if (isSpeechRequest(request)) return { output_text: 'event-backed contribution' }
    return { output_text: JSON.stringify({ reached: false, headline: '', body: '' }) }
  })

  try {
    const session = await startConvene({
      conversationId: seeded.conversationId,
      companyId: seeded.companyId,
      startedBy: seeded.starterId,
      topic: 'publish the true conversation scope',
    })
    const event = await withTimeout(
      waitForEvent(
        events,
        (candidate) => candidate.sessionId === session.id
          && candidate.kind === 'transcript'
          && candidate.data?.authorId === agentId,
        'the transcript Redis event',
      ),
      'the transcript Redis event',
    )
    await withTimeout(waitForSessionEnded(session.id), 'the convene session to end')

    assert.equal(event.type, 'convene')
    assert.equal(event.companyId, seeded.companyId)
    assert.equal(event.conversationId, seeded.conversationId)
    assert.notEqual(event.conversationId, '')
    const { rows } = await pool.query<{ id: string; author_id: string; body: string }>(
      `SELECT id, author_id, body FROM convene_transcript
        WHERE session_id = $1 AND author_id = $2`,
      [session.id, agentId],
    )
    assert.equal(rows.length, 1)
    assert.equal(event.data?.id, rows[0].id)
    assert.equal(event.data?.body, rows[0].body)
  } finally {
    subscriber.disconnect()
  }
})
