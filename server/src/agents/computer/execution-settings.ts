import { isReasoningEffort, type ExecutionObservation, type ExecutionOptions } from '../../../../shared/agent-execution.js'

/** Appended after custom args, without changing the sandbox or approval policy.
 * These allowlisted enums use Codex's raw-string fallback so .cmd wrappers on
 * Windows cannot strip significant TOML quotes. */
export function codexExecutionArgs(options: ExecutionOptions): string[] {
  const args: string[] = []
  if (options.reasoningEffort != null) {
    if (!isReasoningEffort(options.reasoningEffort)) throw new Error('Invalid reasoning effort')
    args.push('-c', `model_reasoning_effort=${options.reasoningEffort}`)
  }
  if (options.speed != null) {
    if (options.speed !== 'standard' && options.speed !== 'fast') throw new Error('Invalid execution speed')
    args.push('-c', `service_tier=${options.speed === 'fast' ? 'fast' : 'default'}`)
  }
  return args
}

/** Only the CLI startup banner, never tool output or the assistant's prose. */
export function codexHeaderObserver(emit: (value: ExecutionObservation) => void): (line: string) => void {
  let phase: 'before' | 'header' | 'done' = 'before'
  let lines = 0
  const value: ExecutionObservation = { model: null, reasoningEffort: null, speed: null, source: 'codex-header' }
  return line => {
    if (phase === 'done') return
    if (++lines > 80) { phase = 'done'; return }
    if (phase === 'before') {
      if (/^OpenAI Codex v\S+/.test(line)) phase = 'header'
      return
    }
    if (/^(user|codex|thinking)$/.test(line)) { phase = 'done'; return }
    const match = /^(model|reasoning effort|service tier):\s*(\S+)\s*$/.exec(line)
    if (!match) return
    if (match[1] === 'model') value.model = match[2]
    if (match[1] === 'reasoning effort' && isReasoningEffort(match[2])) value.reasoningEffort = match[2]
    if (match[1] === 'service tier') value.speed = match[2] === 'fast' || match[2] === 'priority' ? 'fast' : match[2] === 'default' ? 'standard' : null
    emit({ ...value })
  }
}

export function codexSessionObservation(data: Record<string, unknown>): ExecutionObservation {
  const effort = data.reasoningEffort ?? data.reasoning_effort
  const tier = data.serviceTier ?? data.service_tier
  return {
    model: typeof data.model === 'string' ? data.model : null,
    reasoningEffort: isReasoningEffort(effort) ? effort : null,
    speed: tier === 'fast' || tier === 'priority' ? 'fast' : tier === 'default' ? 'standard' : null,
    source: 'codex-session',
  }
}
