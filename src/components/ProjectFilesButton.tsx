import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { projectFilesApi } from '@/api/project-files'
import { useAuth } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useT } from '@/lib/i18n'
import { ProjectFilesDialog } from './ProjectFilesDialog'

export function ProjectFilesButton({ conversationId }: { conversationId: string }) {
  const t = useT()
  const companyId = useAuth(s => s.activeCompanyId)
  const me = useAuth(s => s.user?.id)
  const conversation = useConversations(s => s.list.find(c => c.id === conversationId))
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let current = true
    setEnabled(false); setOpen(false)
    void projectFilesApi.capabilities().then(result => { if (current) setEnabled(result.enabled) }).catch(() => {})
    return () => { current = false }
  }, [companyId])
  if (!enabled || !conversation || conversation.kind !== 'group' || !me || !conversation.members.includes(me)) return null
  return <>
    <button type="button" onClick={() => setOpen(true)} className="shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-skype-deep hover:bg-sky2-50">{t('projectFiles.title')}</button>
    {open && createPortal(<ProjectFilesDialog key={`${companyId}:${conversation.id}:${conversation.projectId ?? ''}`}
      conversation={conversation} onClose={() => setOpen(false)} />, document.body)}
  </>
}
