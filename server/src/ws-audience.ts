import { pool } from './db/pool.js'

/** Resolve current membership at delivery time. A workspace membership alone
 * does not grant access to private groups or DMs. No stale socket cache can
 * keep granting access after a colleague has been removed. */
export async function broadcastRecipients(companyId: string, conversationId?: string): Promise<Set<string>> {
  const { rows } = conversationId
    ? await pool.query<{ user_id: string }>(
      `SELECT cm.user_id FROM company_members cm
         JOIN conversations c ON c.company_id = cm.company_id
        WHERE cm.company_id = $1 AND c.id = $2
          AND c.members @> to_jsonb(ARRAY[cm.user_id::text])`, [companyId, conversationId],
    )
    : await pool.query<{ user_id: string }>(
      'SELECT user_id FROM company_members WHERE company_id = $1', [companyId],
    )
  return new Set(rows.map((row) => row.user_id))
}
