import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type ApiProject, ws } from '@/api/client'
import { fileAsBase64, projectFileAttachment, projectFilesApi, saveDownloadedBlob, type ProjectFileEntry, type ProjectFileListing } from '@/api/project-files'
import { useAuth, useCanManageWorkspace } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useT } from '@/lib/i18n'
import type { Conversation } from '@/types'
import { ProjectGitPanel } from './ProjectGitPanel'

const button = 'rounded-lg border border-ink-100 px-3 py-2 text-sm font-semibold hover:bg-sky2-50 disabled:opacity-40 disabled:cursor-not-allowed'
function bytes(value: number): string { return value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${value} B` }

export function ProjectFilesDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const t = useT()
  const canManage = useCanManageWorkspace()
  const [inspectedProject, setInspectedProject] = useState<ApiProject | null>(null)
  const projectId = inspectedProject?.id ?? conversation.projectId
  const displayedProject = useRef(projectId)
  displayedProject.current = projectId
  const dialog = useRef<HTMLDialogElement>(null)
  const abort = useRef(new AbortController())
  const epoch = useRef(useAuth.getState().contextEpoch)
  const requestSequence = useRef(0)
  const [parentId, setParentId] = useState('root')
  const [trash, setTrash] = useState(false)
  const [listing, setListing] = useState<ProjectFileListing | null>(null)
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [choice, setChoice] = useState(projectId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosenProject = projects.find(p => p.id === choice)
  const isCurrent = () => !abort.current.signal.aborted && useAuth.getState().contextEpoch === epoch.current &&
    displayedProject.current === projectId && useConversations.getState().list.some(c => c.id === conversation.id && c.projectId === conversation.projectId)

  function inspectProject(project: ApiProject | null) {
    setParentId('root'); setTrash(false); setListing(null); setError(''); setInspectedProject(project)
  }

  useEffect(() => {
    // React StrictMode remounts effects. Never reuse its aborted controller.
    abort.current = new AbortController()
    const element = dialog.current
    element?.showModal()
    return () => { abort.current.abort(); requestSequence.current++; element?.close() }
  }, [])
  const reload = useCallback(async () => {
    if (!projectId) return
    const sequence = ++requestSequence.current
    try {
      const next = await projectFilesApi.list(projectId, parentId, trash, abort.current.signal)
      if (sequence === requestSequence.current && isCurrent()) setListing(next)
    } catch (err) {
      if (!isCurrent() || sequence !== requestSequence.current) return
      setListing(null)
      setError(err instanceof ApiError && [403, 404, 410].includes(err.status) ? t('projectFiles.unavailable') : String(err))
    }
  }, [projectId, parentId, trash])
  useEffect(() => { setListing(null); void reload() }, [reload])
  useEffect(() => {
    if (!canManage) return
    void api.listProjects().then(items => { if (isCurrent()) setProjects(items) }).catch(() => {})
  }, [canManage, projectId])
  useEffect(() => {
    // Recheck while visible, also covering server restarts or dropped events.
    const timer = setInterval(() => { if (!busy) void reload() }, 5000)
    const off = ws.on(event => {
      if (event.type === 'workspace.member_removed' || event.type === 'conversation.dissolved' && event.conversationId === conversation.id) onClose()
      if (event.type === 'project.files_changed' && event.conversationId === conversation.id && event.projectId === projectId) void reload()
    })
    return () => { clearInterval(timer); off() }
  }, [reload, busy, projectId, conversation.id])

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (err) { if (isCurrent()) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (isCurrent()) { setBusy(false); await reload() } }
  }
  async function operate(command: Record<string, unknown>) {
    if (!projectId || !listing || !isCurrent()) return
    return projectFilesApi.operation(projectId, listing.bindingVersion, command, abort.current.signal)
  }
  async function destination(): Promise<string | null> {
    const path = window.prompt(t('projectFiles.destination'), '/')
    if (path === null || !projectId) return null
    let current = 'root'
    for (const name of path.split('/').filter(Boolean)) {
      const content = await projectFilesApi.list(projectId, current, false, abort.current.signal)
      const folder = content.entries.find(e => e.kind === 'directory' && e.name === name)
      if (!folder) throw new Error(t('projectFiles.folderMissing'))
      current = folder.id
    }
    return current
  }
  function upload(files: FileList | null) {
    if (!files || !listing) return
    void act(async () => {
      for (const file of Array.from(files)) {
        if (file.size > listing.maxFileBytes) throw new Error(t('projectFiles.fileLimit'))
        const existing = listing.entries.find(e => e.name === file.name)
        if (existing && (existing.kind !== 'file' || !window.confirm(t('projectFiles.overwrite', { name: file.name })))) continue
        const content = await fileAsBase64(file)
        await operate({ type: 'upload', parentId, name: file.name, content, ...(existing ? { entryId: existing.id, expectedVersion: existing.versionId } : {}) })
      }
    })
  }
  function fileAction(item: ProjectFileEntry, action: 'download' | 'share' | 'rename' | 'move' | 'trash' | 'restore' | 'purge' | 'history') {
    void act(async () => {
      if (action === 'download') {
        if (!projectId || !item.versionId) return
        const blob = await projectFilesApi.download({ projectId, entryId: item.id, versionId: item.versionId, name: item.name }, abort.current.signal)
        if (isCurrent()) saveDownloadedBlob(blob, item.name)
      } else if (action === 'share') {
        if (projectId && !inspectedProject) await api.sendMessage(conversation.id, '', projectFileAttachment(projectId, item), null, crypto.randomUUID())
      } else if (action === 'rename') {
        const name = window.prompt(t('projectFiles.newName'), item.name)
        if (name) await operate({ type: 'move', entryId: item.id, expectedRevision: item.revision, parentId, name })
      } else if (action === 'move' || action === 'restore') {
        const target = await destination()
        const name = target && action === 'restore' ? window.prompt(t('projectFiles.newName'), item.name) : item.name
        if (target && name) await operate({ type: action === 'move' ? 'move' : 'restore', entryId: item.id, expectedRevision: item.revision, parentId: target, name })
      } else if (action === 'trash') {
        if (window.confirm(t('projectFiles.trashConfirm', { name: item.name }))) await operate({ type: 'trash', entryId: item.id, expectedRevision: item.revision, recursive: true })
      } else if (window.confirm(t('projectFiles.purgeConfirm', { name: item.name }))) {
        await operate({ type: action === 'history' ? 'purge-history' : 'purge', entryId: item.id, expectedRevision: item.revision, confirm: true })
      }
    })
  }
  async function switchProject(id: string | null) {
    if (!window.confirm(t('projectFiles.switchConfirm'))) return
    await api.attachProject(conversation.id, id)
    if (!isCurrent()) return
    await useConversations.getState().reload()
    onClose()
  }
  return <dialog ref={dialog} onCancel={onClose} className="w-[min(960px,calc(100vw-24px))] max-h-[90vh] rounded-2xl border border-ink-100 p-0 text-ink-900 shadow-2xl backdrop:bg-black/30">
    <section className="flex max-h-[90vh] flex-col bg-white">
      <header className="flex items-center justify-between border-b border-ink-100 p-5">
        <div><h2 className="text-xl font-semibold">{t('projectFiles.title')}</h2><p className="text-sm text-ink-500">{inspectedProject ? `${inspectedProject.name} · ${t('projectFiles.unmounted')}` : `${conversation.title} · ${conversation.projectName ?? t('projectFiles.unmounted')}`}</p></div>
        <button className={button} onClick={onClose} aria-label={t('projectFiles.close')}>×</button>
      </header>
      {canManage && <div className="flex flex-wrap gap-2 border-b border-ink-100 p-4">
        <select className="min-w-0 flex-1 rounded-lg border border-ink-100 p-2" value={choice} onChange={e => setChoice(e.target.value)} disabled={busy} aria-label={t('projectFiles.selectProject')}>
          <option value="">{t('projectFiles.unmounted')}</option>
          {projects.map(p => <option key={p.id} value={p.id} disabled={p.conversationCount > 0 && p.id !== conversation.projectId}>{p.name}{p.status === 'archived' ? ` (${t('projectFiles.archived')})` : ''}</option>)}
        </select>
        <button className={button} disabled={busy || choice === (conversation.projectId ?? '') || chosenProject?.status === 'archived'} onClick={() => void act(() => switchProject(choice || null))}>{t('projectFiles.switch')}</button>
        {chosenProject?.conversationCount === 0 && chosenProject.id !== inspectedProject?.id && <button className={button} disabled={busy} onClick={() => inspectProject(chosenProject)}>{t('projectFiles.inspectUnmounted')}</button>}
        {inspectedProject && <button className={button} disabled={busy} onClick={() => inspectProject(null)}>{t('projectFiles.backToGroup')}</button>}
        {inspectedProject?.status === 'archived' && <button className={button} disabled={busy} onClick={() => void act(async () => {
          await api.archiveProject(inspectedProject.id, false)
          if (isCurrent()) {
            setInspectedProject({ ...inspectedProject, status: 'active' })
            const items = await api.listProjects()
            if (isCurrent()) setProjects(items)
          }
        })}>{t('projectFiles.unarchive')}</button>}
        {!inspectedProject && listing?.readOnly && projects.some(p => p.id === projectId && p.status === 'active') && <button className={button} disabled={busy} onClick={() => void act(() => switchProject(projectId ?? null))}>{t('projectFiles.resume')}</button>}
        <button className={button} disabled={busy} onClick={() => void act(async () => {
          const name = window.prompt(t('projectFiles.projectName'))
          if (name?.trim()) { const created = await api.createProject({ name: name.trim() }); await switchProject(created.id) }
        })}>{t('projectFiles.createProject')}</button>
      </div>}
      {canManage && projectId && <ProjectGitPanel key={projectId} projectId={projectId} />}
      {error && <p role="alert" className="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {projectId ? <>
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
          <button className={button} disabled={busy} onClick={() => { setTrash(!trash); setParentId('root') }}>{trash ? t('projectFiles.files') : t('projectFiles.trash')}</button>
          <button className={button} disabled={busy} onClick={() => void reload()}>{t('projectFiles.refresh')}</button>
          {listing?.canManage && !listing.readOnly && listing.unavailableCount > 0 && <button className={button} disabled={busy} onClick={() => void act(async () => {
            if (window.confirm(t('projectFiles.purgeMissingConfirm'))) await operate({ type: 'purge-missing-history', confirm: true })
          })}>{t('projectFiles.purgeMissing')}</button>}
          {!trash && <>
            <button className={button} disabled={busy || !listing || listing.readOnly} onClick={() => void act(async () => {
              const name = window.prompt(t('projectFiles.folderName'))
              if (name) await operate({ type: 'mkdir', parentId, name })
            })}>{t('projectFiles.newFolder')}</button>
            <label className={`${button} relative ${busy || !listing || listing.readOnly ? 'opacity-40' : 'cursor-pointer'}`}>{t('projectFiles.upload')}
              <input type="file" multiple className="absolute inset-0 w-full opacity-0" aria-label={t('projectFiles.upload')} disabled={busy || !listing || listing.readOnly}
                onChange={e => { upload(e.target.files); e.target.value = '' }} />
            </label>
          </>}
        </div>
        {listing && <div className="space-y-2 px-4 py-3 text-xs text-ink-500">
          <p>{bytes(listing.usedBytes + listing.reservedBytes)} / {bytes(listing.quotaBytes)} · {t('projectFiles.fileLimit')}</p>
          <p>{t('projectFiles.noBackup')}</p>
          {listing.readOnly && <p>{t('projectFiles.readOnly')}</p>}
          {!trash && <nav aria-label={t('projectFiles.path')} className="flex flex-wrap items-center gap-2">
            {listing.ancestors.map(folder => <button className="text-skype-deep hover:underline" key={folder.id} onClick={() => setParentId(folder.id)}>{folder.id === 'root' ? '/' : `${folder.name} /`}</button>)}
          </nav>}
        </div>}
        <div className="min-h-[180px] overflow-y-auto border-t border-ink-100 p-4">
          {!listing ? <p className="text-sm text-ink-500">{error ? t('projectFiles.unavailable') : busy ? t('projectFiles.working') : t('projectFiles.loading')}</p> : listing.entries.length === 0 ? <p className="py-8 text-center text-ink-500">{t('projectFiles.empty')}</p> :
            <ul className="divide-y divide-ink-100">{listing.entries.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1 basis-[200px]">
                <button className="max-w-full truncate text-left font-medium text-skype-ink hover:underline" disabled={trash || busy} onClick={() => item.kind === 'directory' ? setParentId(item.id) : fileAction(item, 'download')}>
                  {item.kind === 'directory' ? '▣ ' : '▤ '}{item.name}
                </button>
                <p className="text-xs text-ink-500">{item.kind === 'file' ? `${bytes(item.size)} · ` : ''}{item.modifiedBy.name} · {new Date(item.modifiedAt).toLocaleString()}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                {!trash && item.kind === 'file' && <button className={button} disabled={busy} onClick={() => fileAction(item, 'download')}>{t('projectFiles.download')}</button>}
                {!inspectedProject && !trash && item.kind === 'file' && <button className={button} disabled={busy || listing.readOnly} onClick={() => fileAction(item, 'share')}>{t('projectFiles.share')}</button>}
                {!listing.readOnly && (trash ? <>
                  <button className={button} disabled={busy} onClick={() => fileAction(item, 'restore')}>{t('projectFiles.restore')}</button>
                  {listing.canManage && <button className={`${button} text-red-600`} disabled={busy} onClick={() => fileAction(item, 'purge')}>{t('projectFiles.purge')}</button>}
                </> : <>
                  <button className={button} disabled={busy} onClick={() => fileAction(item, 'rename')}>{t('projectFiles.rename')}</button>
                  <button className={button} disabled={busy} onClick={() => fileAction(item, 'move')}>{t('projectFiles.move')}</button>
                  <button className={`${button} text-red-600`} disabled={busy} onClick={() => fileAction(item, 'trash')}>{t('projectFiles.delete')}</button>
                  {listing.canManage && item.kind === 'file' && <button className={button} disabled={busy} onClick={() => fileAction(item, 'history')}>{t('projectFiles.clearHistory')}</button>}
                </>)}
              </div>
            </li>)}</ul>}
        </div>
      </> : <p className="p-8 text-center text-ink-500">{t('projectFiles.noProject')}</p>}
    </section>
  </dialog>
}
