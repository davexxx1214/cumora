import { useEffect, useRef, useState } from 'react'
import { api, type ApiGitCredential, type ApiProjectGitSettings } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { useT } from '@/lib/i18n'

const input = 'w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm'
const button = 'rounded-lg border border-ink-100 px-3 py-2 text-sm font-semibold hover:bg-sky2-50 disabled:cursor-not-allowed disabled:opacity-40'

export function ProjectGitPanel({ projectId }: { projectId: string }) {
  const t = useT()
  const epoch = useRef(useAuth.getState().contextEpoch)
  const alive = useRef(true)
  const [settings, setSettings] = useState<ApiProjectGitSettings | null>(null)
  const [credentials, setCredentials] = useState<ApiGitCredential[]>([])
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('')
  const [name, setName] = useState('')
  const [host, setHost] = useState('github.com')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = () => alive.current && useAuth.getState().contextEpoch === epoch.current

  async function reload() {
    const [nextSettings, nextCredentials] = await Promise.all([api.getProjectGit(projectId), api.listGitCredentials()])
    if (!current()) return
    setSettings(nextSettings); setCredentials(nextCredentials)
    setRepositoryUrl(nextSettings?.repositoryUrl ?? '')
    setDefaultBranch(nextSettings?.defaultBranch ?? '')
  }
  useEffect(() => {
    alive.current = true
    void reload().catch(err => { if (current()) setError(err instanceof Error ? err.message : String(err)) })
    return () => { alive.current = false }
  }, [projectId])

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work(); await reload() } catch (err) { if (current()) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (current()) setBusy(false) }
  }

  return <section className="border-b border-ink-100 bg-sky2-50/40 p-4">
    <details>
      <summary className="cursor-pointer text-sm font-semibold text-skype-ink">{t('projectGit.title')}</summary>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-ink-100 bg-white p-4">
          <h3 className="font-semibold">{t('projectGit.repository')}</h3>
          <label className="block text-xs text-ink-500">{t('projectGit.url')}<input className={`${input} mt-1`} value={repositoryUrl} onChange={e => setRepositoryUrl(e.target.value)} placeholder="https://github.com/org/repo.git" disabled={busy} /></label>
          <label className="block text-xs text-ink-500">{t('projectGit.defaultBranch')}<input className={`${input} mt-1`} value={defaultBranch} onChange={e => setDefaultBranch(e.target.value)} placeholder={t('projectGit.remoteDefault')} disabled={busy} /></label>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy || !repositoryUrl.trim()} onClick={() => void act(async () => { setSettings(await api.saveProjectGit(projectId, { repositoryUrl: repositoryUrl.trim(), defaultBranch: defaultBranch.trim() || null })) })}>{t('projectGit.save')}</button>
            <button className={button} disabled={busy || !settings} onClick={() => void act(async () => { setSettings(await api.syncProjectGit(projectId)) })}>{t('projectGit.sync')}</button>
            <button className={`${button} text-red-600`} disabled={busy || !settings} onClick={() => void act(async () => { if (window.confirm(t('projectGit.clearConfirm'))) await api.clearProjectGit(projectId) })}>{t('projectGit.clear')}</button>
          </div>
          {settings && <div className="space-y-1 text-xs text-ink-500">
            <p>{t('projectGit.status')}: {t(`projectGit.status.${settings.syncStatus}`)}</p>
            {settings.resolvedDefaultBranch && <p>{t('projectGit.resolvedBranch')}: <code>{settings.resolvedDefaultBranch}</code></p>}
            {settings.lastCommit && <p>{t('projectGit.commit')}: <code>{settings.lastCommit.slice(0, 12)}</code></p>}
            {settings.lastSyncedAt && <p>{t('projectGit.lastSync')}: {new Date(settings.lastSyncedAt).toLocaleString()}</p>}
            {settings.syncError && <p className="text-red-600">{settings.syncError}</p>}
          </div>}
          <p className="text-xs text-ink-500">{t('projectGit.taskNote')}</p>
        </div>

        <div className="space-y-3 rounded-xl border border-ink-100 bg-white p-4">
          <h3 className="font-semibold">{t('projectGit.credentials')}</h3>
          <p className="text-xs text-ink-500">{t('projectGit.credentialNote')}</p>
          <ul className="space-y-2">{credentials.map(credential => <li key={credential.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 p-3 text-sm">
            <div><p className="font-medium">{credential.name} {credential.active && <span className="text-green-600">· {t('projectGit.active')}</span>}</p><p className="text-xs text-ink-500">{credential.username}@{credential.host} · {credential.tokenHint}</p></div>
            <div className="flex gap-1">{!credential.active && <button className={button} disabled={busy} onClick={() => void act(() => api.activateGitCredential(credential.id).then(() => undefined))}>{t('projectGit.activate')}</button>}<button className={`${button} text-red-600`} disabled={busy} onClick={() => void act(async () => { if (window.confirm(t('projectGit.deleteCredentialConfirm'))) await api.deleteGitCredential(credential.id) })}>{t('projectGit.delete')}</button></div>
          </li>)}</ul>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={input} value={name} onChange={e => setName(e.target.value)} placeholder={t('projectGit.credentialName')} disabled={busy} />
            <input className={input} value={host} onChange={e => setHost(e.target.value)} placeholder="github.com" disabled={busy} />
            <input className={input} value={username} onChange={e => setUsername(e.target.value)} placeholder={t('projectGit.username')} disabled={busy} />
            <input className={input} type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} placeholder={t('projectGit.token')} disabled={busy} />
          </div>
          <button className={button} disabled={busy || !name.trim() || !host.trim() || !username.trim() || !token} onClick={() => void act(async () => {
            await api.createGitCredential({ name: name.trim(), host: host.trim(), username: username.trim(), token, active: true })
            if (current()) { setName(''); setUsername(''); setToken('') }
          })}>{t('projectGit.addCredential')}</button>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    </details>
  </section>
}
