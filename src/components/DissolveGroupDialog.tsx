import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, ApiError } from '@/api/client'
import { useAuth, useCanManageWorkspace } from '@/stores/auth'
import { removeConversation } from '@/stores/conversations'
import { useT } from '@/lib/i18n'
import type { Conversation } from '@/types'

export function DissolveGroupDialog({ conversation, onClose }: {
  conversation: Conversation
  onClose: () => void
}) {
  const canManage = useCanManageWorkspace()
  const meId = useAuth((s) => s.user?.id)
  if (!canManage || conversation.kind !== 'group' || !meId || !conversation.members.includes(meId)) return null
  return <Confirmation conversation={conversation} onClose={onClose} />
}

function Confirmation({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const t = useT()
  const titleId = useId()
  const warningId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { cancelRef.current?.focus() }, [])

  const dissolve = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    const epoch = useAuth.getState().contextEpoch
    try {
      await api.dissolveGroup(conversation.id)
      if (useAuth.getState().contextEpoch !== epoch) return
      removeConversation(conversation.id)
      onClose()
    } catch (err) {
      if (useAuth.getState().contextEpoch !== epoch) return
      // Another administrator may have dissolved it while this dialog was open.
      if (err instanceof ApiError && err.status === 404) {
        removeConversation(conversation.id)
        onClose()
      } else {
        setError(t('convo.dissolveFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const dialog = <div className="fixed inset-0 z-[100] grid place-items-center p-5"
    style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
    onClick={() => { if (!busy) onClose() }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus() }
      }
    }}>
    <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={warningId}
      aria-busy={busy} className="bg-cloud rounded-[16px] shadow-pop max-w-[440px] w-full p-6"
      style={{ border: '1px solid var(--ink-100)' }} onClick={(event) => event.stopPropagation()}>
      <h3 id={titleId} className="font-display font-medium text-[20px] mb-2 break-words">
        {t('convo.dissolveTitle', { title: conversation.title })}
      </h3>
      <p id={warningId} className="text-[13px] text-ink-700 leading-relaxed mb-4">{t('convo.dissolveWarning')}</p>
      {error && <p role="alert" className="text-sm text-coral-deep mb-4">{error}</p>}
      <div className="flex gap-3">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onClose}
          className="flex-1 rounded-lg border border-ink-100 py-2.5 font-semibold text-sm text-ink-700 disabled:opacity-50">
          {t('common.cancel')}
        </button>
        <button type="button" disabled={busy} onClick={() => void dissolve()}
          className="flex-1 rounded-lg py-2.5 font-semibold text-sm text-white disabled:opacity-50"
          style={{ background: 'var(--coral-deep)' }}>
          {t(busy ? 'convo.dissolving' : 'convo.confirmDissolve')}
        </button>
      </div>
    </div>
  </div>
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
