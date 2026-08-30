import { useEffect, useRef, useState } from 'react'
import { type ApiProjectGitCredential, type ApiProjectGitRepository, api } from '@/api/client'
import { type ProjectFileEntry, type ProjectFileListing, projectFilesApi, saveDownloadedBlob } from '@/api/project-files'
import { useT } from '@/lib/i18n'
import { useAuth, useCanManageWorkspace } from '@/stores/auth'

const input = 'w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm'
const button = 'rounded-lg border border-ink-100 px-3 py-2 text-sm font-semibold hover:bg-sky2-50 disabled:cursor-not-allowed disabled:opacity-40'
const statusKeys = {
  not_synced: 'projectGit.status.not_synced', syncing: 'projectGit.status.syncing',
  ready: 'projectGit.status.ready', failed: 'projectGit.status.failed',
} as const

export function ProjectGitPanel({ projectId }: { projectId: string }) {
  const t = useT(), canManage = useCanManageWorkspace()
  const epoch = useRef(useAuth.getState().contextEpoch), alive = useRef(true)
  const [repositories, setRepositories] = useState<ApiProjectGitRepository[]>([])
  const [credential, setCredential] = useState<ApiProjectGitCredential | null>(null)
  const [selected, setSelected] = useState<ApiProjectGitRepository | null>(null)
  const [listing, setListing] = useState<ProjectFileListing | null>(null)
  const [name, setName] = useState(''), [repositoryUrl, setRepositoryUrl] = useState('')
  const [defaultBranch, setDefaultBranch] = useState(''), [username, setUsername] = useState('')
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const current = () => alive.current && useAuth.getState().contextEpoch === epoch.current

  async function reload() {
    const [items, access] = await Promise.all([
      api.listProjectGit(projectId),
      canManage ? api.getProjectGitCredential(projectId) : Promise.resolve(null),
    ])
    if (!current()) return
    setRepositories(items)
    setCredential(access)
    if (access) setUsername(access.username)
    if (selected) {
      const next = items.find(item => item.id === selected.id) ?? null
      setSelected(next)
      if (!next) setListing(null)
    }
  }
  async function browse(repository: ApiProjectGitRepository, folder = repository.rootEntryId) {
    setSelected(repository); setListing(null)
    if (!folder) return
    setError('')
    try {
      const value = await projectFilesApi.list(projectId, folder)
      if (current()) setListing(value)
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => {
    alive.current = true
    void reload().catch(err => { if (current()) setError(err instanceof Error ? err.message : String(err)) })
    return () => { alive.current = false }
  }, [projectId])
  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (err) { if (current()) setError(err instanceof Error ? err.message : String(err)) }
    finally {
      try { if (current()) await reload() } catch (err) {
        if (current()) setError(value => value || (err instanceof Error ? err.message : String(err)))
      }
      if (current()) setBusy(false)
    }
  }
  async function download(item: ProjectFileEntry) {
    if (!item.versionId) return
    setError('')
    try {
      const blob = await projectFilesApi.download({ projectId, entryId: item.id, versionId: item.versionId, name: item.name })
      if (current()) saveDownloadedBlob(blob, item.name)
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : String(err))
    }
  }

  return <section className="border-b border-ink-100 bg-sky2-50/40 p-4">
    <div><h3 className="text-sm font-semibold text-skype-ink">{t('projectGit.title')}</h3>
      <p className="text-xs text-ink-500">{t('projectGit.taskNote')}</p></div>
    {canManage && <details className="mt-3 rounded-xl border border-ink-100 bg-white p-4" open={!credential}>
      <summary className="cursor-pointer text-sm font-semibold">{t('projectGit.credential')}</summary>
      <p className="mt-2 text-xs text-ink-500">{t('projectGit.credentialNote')}</p>
      {credential && <p className="mt-2 text-xs text-ink-500">{credential.username} · {credential.tokenHint}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input className={input} value={username} onChange={event => setUsername(event.target.value)} placeholder={t('projectGit.username')} disabled={busy} />
        <input className={input} type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder={t('projectGit.token')} disabled={busy} />
      </div>
      <button className={button + ' mt-3'} disabled={busy || !username.trim() || !token}
        onClick={() => void act(async () => {
          await api.saveProjectGitCredential(projectId, { username: username.trim(), token })
          if (current()) setToken('')
        })}>{credential ? t('projectGit.replaceCredential') : t('projectGit.saveCredential')}</button>
    </details>}
    <div className="mt-3 grid gap-3 md:grid-cols-[260px_1fr]">
      <div className="space-y-2">
        {repositories.length === 0 && <p className="rounded-xl border border-ink-100 bg-white p-4 text-sm text-ink-500">{t('projectGit.empty')}</p>}
        {repositories.map(repository => <button key={repository.id}
          className={'w-full rounded-xl border p-3 text-left ' + (selected?.id === repository.id ? 'border-skype bg-white' : 'border-ink-100 bg-white/70')}
          onClick={() => void browse(repository)} disabled={busy}>
          <span className="block font-semibold">{repository.name}</span>
          <span className="block truncate text-xs text-ink-500">{repository.host} · {repository.currentBranch ?? t('projectGit.remoteDefault')}</span>
          <span className="block text-xs text-ink-500">{t(statusKeys[repository.syncStatus])}{repository.lastCommit ? ' · ' + repository.lastCommit.slice(0, 10) : ''}</span>
        </button>)}
      </div>
      <div className="min-h-[100px] rounded-xl border border-ink-100 bg-white p-4">
        {!selected ? <p className="text-sm text-ink-500">{t('projectGit.select')}</p> : <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div><p className="font-semibold">{selected.name}</p><p className="max-w-[520px] truncate text-xs text-ink-500">{selected.repositoryUrl}</p></div>
            <div className="flex gap-1">
              {canManage && ['not_synced', 'failed'].includes(selected.syncStatus) && <button className={button} disabled={busy} onClick={() => void act(() => api.syncProjectGit(projectId, selected.id).then(() => undefined))}>{t('projectGit.sync')}</button>}
              {canManage && <button className={button + ' text-red-600'} disabled={busy} onClick={() => void act(async () => {
                if (window.confirm(t('projectGit.clearConfirm'))) { await api.deleteProjectGit(projectId, selected.id); setSelected(null); setListing(null) }
              })}>{t('projectGit.delete')}</button>}
            </div>
          </div>
          {selected.syncError && <p className="mb-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">{selected.syncError}</p>}
          {listing && <nav className="mb-2 flex flex-wrap gap-2 text-xs">{listing.ancestors.filter(item => item.id !== 'root').map(folder =>
            <button className="text-skype-deep hover:underline" key={folder.id} onClick={() => void browse(selected, folder.id)}>
              {folder.id === selected.rootEntryId ? selected.name + ' /' : folder.name + ' /'}</button>)}</nav>}
          {!selected.rootEntryId ? <p className="text-sm text-ink-500">{t('projectGit.notCloned')}</p> : !listing ? <p className="text-sm text-ink-500">{t('projectFiles.loading')}</p> :
            listing.entries.length === 0 ? <p className="py-4 text-center text-sm text-ink-500">{t('projectFiles.empty')}</p> :
            <ul className="divide-y divide-ink-100">{listing.entries.map(item => <li key={item.id} className="flex items-center justify-between gap-3 py-2">
              <button className="min-w-0 truncate text-left text-sm text-skype-ink hover:underline" onClick={() => item.kind === 'directory' ? void browse(selected, item.id) : void download(item)}>
                {item.kind === 'directory' ? '▣ ' : '▤ '}{item.name}</button>
              {item.kind === 'file' && <button className={button} disabled={busy} onClick={() => void download(item)}>{t('projectFiles.download')}</button>}
            </li>)}</ul>}
        </>}
      </div>
    </div>
    {canManage && <details className="mt-3 rounded-xl border border-ink-100 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold">{t('projectGit.add')}</summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input className={input} value={name} onChange={event => setName(event.target.value)} placeholder={t('projectGit.name')} disabled={busy} />
        <input className={input} value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} placeholder="https://github.com/org/repo.git" disabled={busy} />
        <input className={input} value={defaultBranch} onChange={event => setDefaultBranch(event.target.value)} placeholder={t('projectGit.remoteDefault')} disabled={busy} />
      </div>
      {!credential && <p className="mt-2 text-xs text-amber-700">{t('projectGit.credentialRequired')}</p>}
      <button className={button + ' mt-3'} disabled={busy || !credential || !name.trim() || !repositoryUrl.trim()}
        onClick={() => void act(async () => {
          const created = await api.createProjectGit(projectId, { name: name.trim(), repositoryUrl: repositoryUrl.trim(),
            defaultBranch: defaultBranch.trim() || null })
          await api.syncProjectGit(projectId, created.id)
          if (current()) { setName(''); setRepositoryUrl(''); setDefaultBranch('') }
        })}>{t('projectGit.addAndClone')}</button>
    </details>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
  </section>
}
