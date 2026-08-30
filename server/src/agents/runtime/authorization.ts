import { pool } from '../../db/pool.js'
import type { PoolClient } from 'pg'

/**
 * A signed runtime token captures the agent's tenant at mint time. Resolve the
 * live participant row as the authorization source of truth so moving or
 * offboarding an agent revokes every previously minted token.
 */
export async function isRuntimeAgentAuthorized(
  agentId: string,
  companyId: string | null,
): Promise<boolean> {
  if (!companyId) return false
  const { rowCount } = await pool.query(
    `SELECT 1 FROM participants
      WHERE id = $1 AND company_id = $2
        AND kind = 'agent' AND departed_at IS NULL
      LIMIT 1`,
    [agentId, companyId],
  )
  return rowCount === 1
}

/** Hold the current agent and every requested conversation membership stable
 * while an ephemeral Redis/pubsub side effect runs. Membership mutation uses
 * the same participant -> conversation lock order, so a revoke is linearized
 * either wholly before or wholly after the side effect. */
export async function withRuntimeConversationAuthorization<T>(args: {
  agentId: string
  companyId: string
  conversationIds: readonly string[]
  task: () => Promise<T>
}): Promise<{ authorized: boolean; result?: T }> {
  const conversationIds = [...new Set(args.conversationIds)].sort()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participant = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind = 'agent' AND departed_at IS NULL
        FOR SHARE`,
      [args.agentId, args.companyId],
    )
    if (!participant.rowCount) {
      await client.query('ROLLBACK')
      return { authorized: false }
    }
    if (conversationIds.length > 0) {
      const conversations = await client.query<{ id: string }>(
        `SELECT id FROM conversations
          WHERE company_id = $1 AND id = ANY($2::text[])
            AND members @> to_jsonb(ARRAY[$3::text])
          ORDER BY id FOR SHARE`,
        [args.companyId, conversationIds, args.agentId],
      )
      if (conversations.rows.length !== conversationIds.length) {
        await client.query('ROLLBACK')
        return { authorized: false }
      }
    }
    const result = await args.task()
    await client.query('COMMIT')
    return { authorized: true, result }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Authorize a read-cursor advance against the exact persisted message. The
 * durable departure-recipient exception lets a just-kicked agent acknowledge
 * its one terminal system row without restoring conversation access. */
export async function withRuntimeMessageReadAuthorization<T>(args: {
  agentId: string
  companyId: string
  conversationId: string
  messageId: string
  task: (client: PoolClient) => Promise<T>
}): Promise<{ authorized: boolean; result?: T }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participant = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind = 'agent' AND departed_at IS NULL
        FOR SHARE`,
      [args.agentId, args.companyId],
    )
    if (!participant.rowCount) {
      await client.query('ROLLBACK')
      return { authorized: false }
    }
    const allowed = await client.query(
      `SELECT m.id
         FROM conversations c
         JOIN messages m
           ON m.id = $4 AND m.conversation_id = c.id AND m.company_id = c.company_id
        WHERE c.id = $1 AND c.company_id = $2
          AND (
            c.members @> to_jsonb(ARRAY[$3::text])
            OR (m.kind = 'system' AND m.delivery_recipient_id = $3)
          )
        FOR SHARE OF c, m`,
      [args.conversationId, args.companyId, args.agentId, args.messageId],
    )
    if (!allowed.rowCount) {
      await client.query('ROLLBACK')
      return { authorized: false }
    }
    const result = await args.task(client)
    await client.query('COMMIT')
    return { authorized: true, result }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
