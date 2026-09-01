import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, ws } from '@/api/client'
import { useT } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { ProjectWorkflowDialog } from './ProjectWorkflowDialog'

export function ProjectWorkflowButton({ conversationId }: { conversationId: string }) {
  const t = useT()
  const companyId = useAuth(s => s.activeCompanyId)
  const me = useAuth(s => s.user?.id)
  const conversation = useConversations(s => s.list.find(c => c.id === conversationId))
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    setOpen(false); setUnread(0); setEnabled(false)
    if (!conversation?.projectId) return
    let active = true
    void api.projectWorkflowCapabilities().then(capability => {
      if (!active) return
      setEnabled(capability.enabled)
      if (capability.enabled) void api.listProjectWorkflowNotifications(conversation.id).then(rows => { if (active) setUnread(rows.length) }).catch(() => {})
    }).catch(() => {})
    const off = ws.on(event => {
      if (event.type !== 'project.workflow_changed' || event.conversationId !== conversation.id) return
      if (event.notificationRecipientIds?.includes(me ?? '')) setUnread(value => value + 1)
    })
    return () => { active = false; off() }
  }, [companyId, conversation?.id, conversation?.projectId, me])

  if (!enabled || !conversation?.projectId || conversation.kind !== 'group' || !me || !conversation.members.includes(me)) return null
  return <>
    <button type="button" onClick={() => {
      setOpen(true); setUnread(0)
      void api.markProjectWorkflowNotificationsRead(conversation.id).catch(() => {})
    }}
      className="relative shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-skype-deep hover:bg-sky2-50">
      {t('projectWorkflow.title')}
      {unread > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-500 px-1 text-[10px] leading-4 text-white">{Math.min(unread, 99)}</span>}
    </button>
    {open && createPortal(<ProjectWorkflowDialog key={`${companyId}:${conversation.id}:${conversation.projectId}`}
      conversation={conversation} onClose={() => setOpen(false)} />, document.body)}
  </>
}
