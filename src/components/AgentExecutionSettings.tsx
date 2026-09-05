import { useT } from '@/lib/i18n'
import type { Participant } from '@/types'

/** Actual observations stay separate from saved values and CLI arguments. */
export function AgentExecutionSettings({ agent }: { agent: Participant }) {
  const t = useT()
  const report = agent.executionReport?.settingsVersion === (agent.executionSettingsVersion ?? 0) ? agent.executionReport : null
  const supported = agent.engine === 'codex'
  const inherited = t('agent.executionInherit')
  const unknown = t('agent.executionUnknown')
  const unsupported = t('agent.executionUnsupported')
  const speed = (value: string | null | undefined) => value === 'fast' ? t('agent.speedFast') : value === 'standard' ? t('agent.speedStandard') : inherited
  const rows = [
    [t('agent.executionModel'), agent.model || inherited, report?.model || unknown],
    [t('agent.executionEffort'), supported ? agent.reasoningEffort || inherited : unsupported, supported ? report?.reasoningEffort || unknown : unsupported],
    [t('agent.executionSpeed'), supported ? speed(agent.speed) : unsupported, supported ? report?.speed ? speed(report.speed) : unknown : unsupported],
  ]
  return <div className="rounded-[12px] bg-sky2-50 p-3 mb-3 text-[12px] text-ink-700" aria-label={t('agent.executionTitle')}>
    <table className="w-full table-fixed text-left">
      <thead><tr className="text-ink-500"><th className="w-[22%] font-normal">{t('agent.executionTitle')}</th><th className="font-normal">{t('agent.executionSaved')}</th><th className="font-normal">{t('agent.executionActual')}</th></tr></thead>
      <tbody>{rows.map(([label, saved, actual]) => <tr key={label}><th className="py-1 font-medium">{label}</th><td className="break-words pr-2">{saved}</td><td className="break-words">{actual}</td></tr>)}</tbody>
    </table>
    <div className="mt-2 text-[11px] text-ink-500">
      {report ? <>
        <div>{t('agent.executionObservedAt')} {new Date(report.observedAt).toLocaleString()}</div>
        <div>{t('agent.executionSent')}: {report.requested.model || inherited} · {report.requested.reasoningEffort || inherited} · {speed(report.requested.speed)}</div>
      </> : t('agent.executionPending')}
    </div>
  </div>
}
