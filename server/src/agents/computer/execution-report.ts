import { pool } from '../../db/pool.js'
import { isReasoningEffort, isExecutionSpeed, type ExecutionReport } from '../../../../shared/agent-execution.js'

export function parseExecutionReport(value: unknown): ExecutionReport | null {
  if (!value || typeof value !== 'object') return null
  const body = value as Record<string, unknown>
  const nullableModel = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\r\n\0]/.test(v))
  const validEffort = (v: unknown) => v === null || isReasoningEffort(v)
  const validSpeed = (v: unknown) => v === null || isExecutionSpeed(v)
  const requested = body.requested as Record<string, unknown> | undefined
  if (!Number.isSafeInteger(body.settingsVersion) || (body.settingsVersion as number) < 0 ||
      typeof body.source !== 'string' || !['codex-header', 'codex-session', 'engine-event'].includes(body.source) ||
      !nullableModel(body.model) || !validEffort(body.reasoningEffort) || !validSpeed(body.speed) ||
      !requested || !nullableModel(requested.model) || !validEffort(requested.reasoningEffort) || !validSpeed(requested.speed)) return null
  // Allowlist: no raw config, environment, log, path or credentials are stored.
  return {
    model: body.model, reasoningEffort: body.reasoningEffort, speed: body.speed,
    source: body.source, settingsVersion: body.settingsVersion, observedAt: new Date().toISOString(),
    requested: { model: requested.model, reasoningEffort: requested.reasoningEffort, speed: requested.speed },
  } as ExecutionReport
}

export async function saveExecutionReport(agentId: string, companyId: string, computerId: string, report: ExecutionReport): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE participants SET execution_report = $1::jsonb
      WHERE id = $2 AND company_id = $3 AND computer_id = $4 AND kind = 'agent'
        AND departed_at IS NULL AND execution_settings_version = $5
        AND EXISTS (SELECT 1 FROM computers c WHERE c.id = $4 AND c.company_id = $3 AND c.revoked_at IS NULL)`,
    [JSON.stringify(report), agentId, companyId, computerId, report.settingsVersion],
  )
  return !!rowCount
}
