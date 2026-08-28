import { useCallback, useEffect, useState } from 'react'
import { api } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { useConversations } from '@/stores/conversations'
import { useT } from '@/lib/i18n'

type Member = Awaited<ReturnType<typeof api.listWorkspaceMembers>>[number]

export function WorkspaceMembersModal({ companyId, companyName, onClose }: {
  companyId: string; companyName: string; onClose: () => void
}) {
  const t = useT()
  const me = useMe()
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Member | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(async () => {
    try { setMembers(await api.listWorkspaceMembers(companyId)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [companyId])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const remove = async () => {
    if (!confirm || busy) return
    setBusy(true); setError(null)
    try {
      await api.removeWorkspaceMember(companyId, confirm.id)
      setConfirm(null)
      await Promise.all([reload(), useParticipants.getState().refresh(), useConversations.getState().reload()])
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-4 bg-black/40" onClick={() => { if (!busy) onClose() }}>
      <section role="dialog" aria-modal="true" aria-labelledby="workspace-members-title"
        className="bg-cloud rounded-2xl shadow-pop w-full max-w-lg max-h-[85vh] overflow-y-auto p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h2 id="workspace-members-title" className="text-lg font-semibold">{t('workspaceMembers.title', { name: companyName })}</h2>
          <button onClick={onClose} disabled={busy} aria-label={t('info.close')} className="text-xl px-2">×</button>
        </div>
        {loading && <p>{t('invite.loading')}</p>}
        {members.map((member) => (
          <div key={member.id} className="flex items-center gap-3 border-b border-ink-100 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">{member.name}</div>
              <div className="text-xs text-ink-500 truncate">{member.email} · {member.role}</div>
            </div>
            {!member.isOwner && member.id !== me && <button disabled={busy} onClick={() => setConfirm(member)}
              className="text-sm text-coral-deep px-3 py-2 rounded-lg hover:bg-coral-soft disabled:opacity-50">{t('workspaceMembers.remove')}</button>}
          </div>
        ))}
        {confirm && <div className="rounded-xl border border-coral-soft bg-coral-soft/30 p-3 space-y-3">
          <p className="text-sm">{t('workspaceMembers.confirm', { name: confirm.name, company: companyName })}</p>
          <div className="flex justify-end gap-3">
            <button disabled={busy} onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
            <button disabled={busy} onClick={() => void remove()} className="rounded-lg bg-coral-deep px-3 py-2 text-white disabled:opacity-50">
              {busy ? '…' : t('workspaceMembers.remove')}
            </button>
          </div>
        </div>}
        {error && <p role="alert" className="text-sm text-coral-deep">{error}</p>}
      </section>
    </div>
  )
}
