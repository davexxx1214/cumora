/**
 * Shared membership-change plumbing.
 *
 * Both the agent-side CLI (`cumora invite / leave / kick`) and the
 * human-side HTTP endpoints (`POST /conversations/:id/members`, `POST
 * /conversations/:id/leave`) need to do the same two things on every
 * membership mutation:
 *
 *   1. Post a `kind='system'` message into the conversation describing
 *      what happened (joined / left / kicked), so the audit trail is
 *      visible to remaining members.
 *   2. Publish CH_MESSAGE_NEW after a real membership change. The database
 *      mutation must happen first: otherwise a concurrently revoked actor can
 *      emit a false audit row and then fail the protected write. Departure
 *      notices carry a durable delivery recipient so the removed agent still
 *      sees the one row that explains why the conversation disappeared.
 *
 * Putting both in one file keeps the CLI and HTTP paths from drifting.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW, publish, type MessageNewEvent } from '../redis.js'

export type MembershipKind = 'joined' | 'left' | 'kicked'

export interface MembershipMutationResult {
  /** The current database value after this operation serialized on the row. */
  members: string[]
  /** Audit row committed atomically with the membership change. */
  systemMessageId: string
}

interface CommittedMembershipChange {
  result: MembershipMutationResult
  event: MessageNewEvent
}

/** Serialize membership authorization against offboarding / tenant moves.
 * The UPDATE below still repeats every predicate; these row locks close the
 * narrower race where a participant row changes after a statement snapshot is
 * taken while the conversation UPDATE is waiting on another writer. IDs are
 * sorted so cross-kicks cannot deadlock by locking actor/target in opposite
 * orders. */
async function withActiveParticipantLocks<T>(args: {
  participantIds: string[]
  companyId: string
  run: (client: PoolClient) => Promise<T>
}): Promise<T | null> {
  const client = await pool.connect()
  const participantIds = [...new Set(args.participantIds)].sort()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: string }>(
      `SELECT id
         FROM participants
        WHERE company_id = $1
          AND id = ANY($2::text[])
          AND departed_at IS NULL
        ORDER BY id
        FOR UPDATE`,
      [args.companyId, participantIds],
    )
    if (rows.length !== participantIds.length) {
      await client.query('ROLLBACK')
      return null
    }
    const result = await args.run(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* preserve original error */ })
    throw err
  } finally {
    client.release()
  }
}

async function insertMembershipSystemMessage(args: {
  client: PoolClient
  conversationId: string
  companyId: string
  actorId: string
  kind: MembershipKind
  participantId: string
  members: string[]
}): Promise<CommittedMembershipChange> {
  const messageId = `m-${randomUUID()}`
  const sequence = await nextConversationSequenceWithClient(args.client, args.conversationId)
  const body = JSON.stringify({
    kind: args.kind,
    participantId: args.participantId,
    actorId: args.actorId,
  })
  const deliveryRecipientId = args.kind === 'joined' ? null : args.participantId
  await args.client.query(
    `INSERT INTO messages (
       id, conversation_id, author_id, kind, body, sequence, company_id,
       delivery_recipient_id
     ) VALUES ($1,$2,$3,'system',$4,$5,$6,$7)`,
    [
      messageId, args.conversationId, args.actorId, body, sequence,
      args.companyId, deliveryRecipientId,
    ],
  )
  return {
    result: { members: args.members, systemMessageId: messageId },
    event: {
      type: 'message.new',
      conversationId: args.conversationId,
      companyId: args.companyId,
      message: {
        id: messageId,
        conversationId: args.conversationId,
        authorId: args.actorId,
        kind: 'system',
        body,
        sequence,
        at: new Date().toISOString(),
        ...(deliveryRecipientId ? { deliveryRecipientId } : {}),
      },
    },
  }
}

/** Redis is the wake accelerator; the committed message is the source of
 * truth. Do not turn a transient publish failure into an apparent mutation
 * failure that callers retry after the database already changed. */
async function publishCommittedMembershipChange(
  committed: CommittedMembershipChange | null,
): Promise<MembershipMutationResult | null> {
  if (!committed) return null
  await publish(CH_MESSAGE_NEW, committed.event).catch((err) => {
    console.warn(
      `[membership] publish ${committed.result.systemMessageId} failed; row remains durable`,
      err instanceof Error ? err.message : err,
    )
  })
  return committed.result
}

/**
 * Add `memberId` to a conversation's member list and return the list as it
 * stands AFTER the write.
 *
 * The array is edited by Postgres, not by us. Every caller used to SELECT
 * `members`, splice it in JavaScript and write the whole array back, which
 * makes two overlapping membership changes a last-write-wins race: the second
 * write is computed from a snapshot taken before the first, so the first one
 * is erased with no error anywhere.
 *
 * That is not a rare interleaving here. The scheduler wakes several agents for
 * the same message, and `invite` / `leave` / `kick` are what those agents do
 * next. And the damage is silent in the worst way: the `joined` system row is
 * posted regardless, so the transcript records a join that did not happen,
 * while the agent's mailbox query (`members @> [agentId]`) never matches, so
 * they are simply never woken for that conversation again.
 *
 * Authorization is deliberately repeated in this single UPDATE. Route-level
 * SELECTs are only for friendly error messages; they are stale the moment a
 * concurrent kick, offboarding, or tenant move commits. Both the actor and the
 * target therefore have to be active participants in the conversation's
 * current tenant at the exact write boundary.
 *
 * Returns null when the write was not authorized or no longer necessary. The
 * helper intentionally performs no fallback SELECT: a second statement would
 * create an ABA window in which a removed-and-reinvited actor could turn a
 * rejected mutation into an apparent idempotent success.
 */
export async function addConversationMember(args: {
  conversationId: string
  memberId: string
  /** The member authorizing this mutation. Checked in the UPDATE itself so a
   * concurrent kick/revocation cannot leave a stale request authorized. */
  actorId: string
  companyId: string
}): Promise<MembershipMutationResult | null> {
  const committed = await withActiveParticipantLocks({
    participantIds: [args.actorId, args.memberId],
    companyId: args.companyId,
    run: async (client) => {
      const { rows } = await client.query<{ members: string[] }>(
        `UPDATE conversations c
        SET members = members || to_jsonb(ARRAY[$2::text]), updated_at = NOW()
      WHERE c.id = $1
        AND c.company_id = $4
        AND c.members @> to_jsonb(ARRAY[$3::text])
        AND NOT (c.members @> to_jsonb(ARRAY[$2::text]))
        AND EXISTS (
          SELECT 1 FROM participants actor
           WHERE actor.id = $3 AND actor.company_id = c.company_id
             AND actor.departed_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM participants target
           WHERE target.id = $2 AND target.company_id = c.company_id
             AND target.departed_at IS NULL
        )
      RETURNING members`,
        [args.conversationId, args.memberId, args.actorId, args.companyId],
      )
      if (!rows[0]) return null
      return insertMembershipSystemMessage({
        client,
        conversationId: args.conversationId,
        companyId: args.companyId,
        actorId: args.actorId,
        kind: 'joined',
        participantId: args.memberId,
        members: rows[0].members,
      })
    },
  })
  return publishCommittedMembershipChange(committed)
}

/**
 * Remove `memberId` from a conversation's member list, returning the list as
 * it stands after the write. Same reasoning as addConversationMember.
 *
 * `jsonb - text` deletes every matching element, so this is idempotent and
 * also cleans up a duplicate left behind by the old racy path.
 */
export async function removeConversationMember(args: {
  conversationId: string
  memberId: string
  actorId: string
  companyId: string
  /** Leave is allowed to remove the final member. Kick passes this only after
   * explicit --confirm-empty; keeping the cardinality predicate in the UPDATE
   * makes two concurrent kicks re-check it after the row lock is acquired. */
  allowSoleMember?: boolean
  /** Workspace owners/admins may remove a member from a group they do not
   * personally belong to. The role is checked in the same locked UPDATE; this
   * flag is never used by agent or ordinary member paths. */
  allowPrivilegedActor?: boolean
  kind: 'left' | 'kicked'
}): Promise<MembershipMutationResult | null> {
  if ((args.kind === 'left') !== (args.actorId === args.memberId)) {
    throw new Error('membership removal kind does not match actor/participant')
  }
  const committed = await withActiveParticipantLocks({
    participantIds: [args.actorId, args.memberId],
    companyId: args.companyId,
    run: async (client) => {
      const { rows } = await client.query<{ members: string[] }>(
        `UPDATE conversations c
        SET members = members - $2::text, updated_at = NOW()
      WHERE c.id = $1
        AND c.company_id = $4
        AND c.members @> to_jsonb(ARRAY[$2::text])
        AND (
          c.members @> to_jsonb(ARRAY[$3::text])
          OR (
            $6::boolean
            AND EXISTS (
              SELECT 1 FROM company_members administrator
               WHERE administrator.company_id = c.company_id
                 AND administrator.user_id = $3
                 AND administrator.role IN ('owner', 'admin')
            )
          )
        )
        AND ($5::boolean OR jsonb_array_length(c.members - $2::text) <> 1)
        AND EXISTS (
          SELECT 1 FROM participants actor
           WHERE actor.id = $3 AND actor.company_id = c.company_id
             AND actor.departed_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM participants target
           WHERE target.id = $2 AND target.company_id = c.company_id
             AND target.departed_at IS NULL
        )
      RETURNING members`,
        [
          args.conversationId,
          args.memberId,
          args.actorId,
          args.companyId,
          Boolean(args.allowSoleMember),
          Boolean(args.allowPrivilegedActor),
        ],
      )
      if (!rows[0]) return null
      return insertMembershipSystemMessage({
        client,
        conversationId: args.conversationId,
        companyId: args.companyId,
        actorId: args.actorId,
        kind: args.kind,
        participantId: args.memberId,
        members: rows[0].members,
      })
    },
  })
  return publishCommittedMembershipChange(committed)
}

/** Atomically claim the next sequence number for a conversation.
 *  Same UPSERT pattern as the human reply path and `cumora reply`. */
async function nextConversationSequenceWithClient(
  client: PoolClient,
  conversationId: string,
): Promise<number> {
  const { rows } = await client.query<{ seq: number }>(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
     RETURNING next_sequence - 1 AS seq`,
    [conversationId],
  )
  return rows[0]?.seq ?? 1
}

export async function nextConversationSequence(conversationId: string): Promise<number> {
  const { rows } = await pool.query<{ seq: number }>(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
     RETURNING next_sequence - 1 AS seq`,
    [conversationId],
  )
  return rows[0]?.seq ?? 1
}
