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
 *   2. Publish CH_MESSAGE_NEW so the mailbox scheduler wakes everyone
 *      who's a member at message-creation time — including the newly
 *      added member (for joins) or the departing one (for leaves /
 *      kicks, when the system message is posted BEFORE the members
 *      array update).
 *
 * Putting both in one file keeps the CLI and HTTP paths from drifting.
 */
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW, publish } from '../redis.js'

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
 * `companyId` is the tenant guard the HTTP paths already applied; omit it on
 * the agent CLI paths, which resolve the conversation by id.
 *
 * Returns null when the conversation does not exist (or is not in that tenant).
 */
export async function addConversationMember(args: {
  conversationId: string
  memberId: string
  companyId?: string | null
}): Promise<string[] | null> {
  const tenant = args.companyId ? ' AND company_id = $3' : ''
  const params = args.companyId
    ? [args.conversationId, args.memberId, args.companyId]
    : [args.conversationId, args.memberId]
  const { rows } = await pool.query<{ members: string[] }>(
    `UPDATE conversations
        SET members = members || to_jsonb(ARRAY[$2::text]), updated_at = NOW()
      WHERE id = $1 AND NOT (members @> to_jsonb(ARRAY[$2::text]))${tenant}
      RETURNING members`,
    params,
  )
  if (rows[0]) return rows[0].members
  // No row updated: either they were already a member — which is the outcome
  // the caller wanted, and the reason the guard is in the WHERE rather than
  // only in JavaScript — or the conversation is gone. Read back to tell those
  // apart, and to answer with a current list rather than a stale one.
  const { rows: current } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = $1${args.companyId ? ' AND company_id = $2' : ''}`,
    args.companyId ? [args.conversationId, args.companyId] : [args.conversationId],
  )
  return current[0]?.members ?? null
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
  companyId?: string | null
}): Promise<string[] | null> {
  const tenant = args.companyId ? ' AND company_id = $3' : ''
  const params = args.companyId
    ? [args.conversationId, args.memberId, args.companyId]
    : [args.conversationId, args.memberId]
  const { rows } = await pool.query<{ members: string[] }>(
    `UPDATE conversations
        SET members = members - $2::text, updated_at = NOW()
      WHERE id = $1${tenant}
      RETURNING members`,
    params,
  )
  return rows[0]?.members ?? null
}

/** Atomically claim the next sequence number for a conversation.
 *  Same UPSERT pattern as the human reply path and `cumora reply`. */
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

export type MembershipKind = 'joined' | 'left' | 'kicked'

/** Insert a membership system row + broadcast it. Order of operations
 *  vs the actual `conversations.members` mutation matters:
 *    - For 'joined': call AFTER members has been updated. The new
 *      member is now in the array, so the scheduler wakes them on the
 *      CH_MESSAGE_NEW event and they perceive the join.
 *    - For 'left' / 'kicked': call BEFORE removing the departing
 *      member. The mailbox query filters by current members, so if we
 *      removed them first they'd never see the system row that explains
 *      why their inbox went quiet. */
export async function postMembershipSystemMessage(args: {
  conversationId: string
  companyId: string | null
  actorId: string
  kind: MembershipKind
  participantId: string
}): Promise<{ messageId: string; sequence: number }> {
  const messageId = `m-${randomUUID()}`
  const sequence = await nextConversationSequence(args.conversationId)
  const body = JSON.stringify({
    kind: args.kind,
    participantId: args.participantId,
    actorId: args.actorId,
  })
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1,$2,$3,'system',$4,$5,$6)`,
    [messageId, args.conversationId, args.actorId, body, sequence, args.companyId],
  )
  await publish(CH_MESSAGE_NEW, {
    type: 'message.new',
    conversationId: args.conversationId,
    companyId: args.companyId ?? undefined,
    message: {
      id: messageId, conversationId: args.conversationId, authorId: args.actorId,
      kind: 'system', body, sequence,
      at: new Date().toISOString(),
    },
  })
  return { messageId, sequence }
}
