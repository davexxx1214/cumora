import { pool } from '../../db/pool.js'

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
