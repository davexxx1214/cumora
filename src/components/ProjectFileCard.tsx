import { useEffect, useRef, useState } from 'react'
import { projectFilesApi, saveDownloadedBlob, type ProjectFileReference } from '@/api/project-files'
import { useAuth } from '@/stores/auth'
import { useT } from '@/lib/i18n'

export function ProjectFileCard({ reference, size }: { reference: ProjectFileReference; size?: number }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)
  const company = useAuth(s => s.activeCompanyId)
  useEffect(() => () => { request.current?.abort() }, [company, reference.projectId, reference.entryId, reference.versionId])
  async function download() {
    const epoch = useAuth.getState().contextEpoch
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    setBusy(true); setError(false)
    try {
      const blob = await projectFilesApi.download(reference, controller.signal)
      if (!controller.signal.aborted && epoch === useAuth.getState().contextEpoch) saveDownloadedBlob(blob, reference.name)
    } catch { if (!controller.signal.aborted) setError(true) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <div className="mt-2 max-w-md rounded-xl border border-ink-100 bg-sky2-50 p-3">
    <button type="button" disabled={busy} onClick={() => void download()} className="flex w-full items-center gap-3 text-left disabled:opacity-50">
      <span aria-hidden="true" className="text-2xl text-skype-deep">▤</span>
      <span className="min-w-0"><span className="block truncate font-semibold text-ink-900">{reference.name}</span>
        <span className="block text-xs text-ink-500">{t('projectFiles.title')}{size !== undefined ? ` · ${Math.ceil(size / 1024)} KB` : ''} · {busy ? t('projectFiles.loading') : t('projectFiles.download')}</span>
      </span>
    </button>
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{t('projectFiles.unavailable')}</p>}
  </div>
}
