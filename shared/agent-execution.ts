/** Public settings only. Never put engine credentials or raw config in reports. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
export type ExecutionSpeed = 'standard' | 'fast'
export interface ExecutionOptions {
  reasoningEffort?: ReasoningEffort | null
  speed?: ExecutionSpeed | null
}
export interface ExecutionObservation {
  model: string | null
  reasoningEffort: ReasoningEffort | null
  speed: ExecutionSpeed | null
  source: 'codex-header' | 'codex-session' | 'engine-event'
}
export interface ExecutionReport extends ExecutionObservation {
  observedAt: string
  settingsVersion: number
  requested: { model: string | null; reasoningEffort: ReasoningEffort | null; speed: ExecutionSpeed | null }
}
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}
export function isExecutionSpeed(value: unknown): value is ExecutionSpeed {
  return value === 'standard' || value === 'fast'
}
