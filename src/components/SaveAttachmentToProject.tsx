import { useEffect, useState } from 'react'
import { projectFilesApi } from '@/api/project-files'
import { useConversations } from '@/stores/conversations'
import { useAuth } from '@/stores/auth'
import { useT } from '@/lib/i18n'

export function SaveAttachmentToProject({ conversationId, messageId, name }: { conversationId: string; messageId: string; name: string }) {
  const t = useT()
  const projectId = useConversations(s => s.list.find(c => c.id === conversationId)?.projectId)
  const company = useAuth(s => s.activeCompanyId)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  useEffect(() => {
    let current = true
    setResult(''); setEnabled(false)
    if (projectId) void projectFilesApi.capabilities().then(r => { if (current) setEnabled(r.enabled) }).catch(() => {})
    return () => { current = false }
  }, [company, projectId])
  if (!enabled || !projectId) return null
  async function save() {
    if (!projectId) return
    const epoch = useAuth.getState().contextEpoch
    const current = () => epoch === useAuth.getState().contextEpoch && useConversations.getState().list.some(c => c.id === conversationId && c.projectId === projectId)
    setBusy(true); setResult('')
    try {
      const listing = await projectFilesApi.list(projectId)
      let target = name
      if (listing.entries.some(e => e.name === name)) {
        target = window.prompt(t('projectFiles.newName'), name) ?? ''
        if (!target) return
      }
      if (!current()) return
      await projectFilesApi.saveAttachment(projectId, listing.bindingVersion, conversationId, messageId, target)
      if (current()) setResult(t('projectFiles.savedAttachment'))
    } catch (error) { if (current()) setResult(error instanceof Error ? error.message : String(error)) }
    finally { if (current()) setBusy(false) }
  }
  return <div className="mt-1 text-xs"><button type="button" className="text-skype-deep hover:underline disabled:opacity-50" disabled={busy} onClick={() => void save()}>{t('projectFiles.saveAttachment')}</button>
    {result && <p role="status" className="text-ink-500">{result}</p>}
  </div>
}
