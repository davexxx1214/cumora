import { getActiveCompanyId, getAuthToken } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { type ApiAttachment, ApiError, api, getServerOrigin, http } from './client'

export interface ProjectFileEntry {
  id: string; parentId: string | null; name: string; kind: 'file' | 'directory'
  revision: string; versionId: string | null; size: number; modifiedAt: string
  modifiedBy: { id: string; name: string; kind: 'human' | 'agent' }
  deletedAt: string | null; trashRoot: string | null
  source?: { kind: 'git'; repositoryId: string }
}
export interface ProjectFileListing {
  entries: ProjectFileEntry[]; ancestors: ProjectFileEntry[]; usedBytes: number; reservedBytes: number
  quotaBytes: number; maxFileBytes: number; canManage: boolean; readOnly: boolean; epoch: string; bindingVersion: string; unavailableCount: number
}
export interface ProjectFileReference { projectId: string; entryId: string; versionId: string; name: string }
export const projectFilesApi = {
  capabilities: () => http<{ enabled: boolean }>('/project-files/capabilities'),
  saveAttachment: (projectId: string, bindingVersion: string, conversationId: string, messageId: string, name: string) =>
    http(`/project-files/${encodeURIComponent(projectId)}/save-attachment`, { method: 'POST',
      body: JSON.stringify({ bindingVersion, conversationId, messageId, name, parentId: 'root', requestId: crypto.randomUUID() }) }),
  list: (projectId: string, parentId = 'root', trash = false, signal?: AbortSignal) =>
    http<ProjectFileListing>(`/project-files/${encodeURIComponent(projectId)}/entries?parentId=${encodeURIComponent(parentId)}&trash=${trash ? '1' : '0'}`, { signal }),
  operation: (projectId: string, bindingVersion: string, command: Record<string, unknown>, signal?: AbortSignal) =>
    http<{ entry?: ProjectFileEntry; ok?: boolean }>(`/project-files/${encodeURIComponent(projectId)}/operations`, {
      method: 'POST', body: JSON.stringify({ bindingVersion, requestId: crypto.randomUUID(), command }), signal,
    }),
  async download(reference: ProjectFileReference, signal?: AbortSignal): Promise<Blob> {
    const headers: Record<string, string> = { Authorization: `Bearer ${getAuthToken() ?? ''}`, 'x-company-id': getActiveCompanyId() ?? '' }
    const response = await fetch(`${getServerOrigin()}/api/project-files/${encodeURIComponent(reference.projectId)}/entries/${encodeURIComponent(reference.entryId)}/download?versionId=${encodeURIComponent(reference.versionId)}`, { headers, signal, cache: 'no-store' })
    if (!response.ok) throw new ApiError('Project file is unavailable', response.status)
    return response.blob()
  },
}

export function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function projectFileAttachment(projectId: string, entry: ProjectFileEntry): ApiAttachment {
  if (entry.kind !== 'file' || !entry.versionId) throw new Error('Select a current project file.')
  return { url: '', name: entry.name, kind: 'file', mime: 'application/octet-stream', size: entry.size,
    projectFile: { projectId, entryId: entry.id, versionId: entry.versionId, name: entry.name } }
}

/** A group with an enabled mount sends attachment bytes straight to its private
 * project root. Never upload publicly first and try to fix the URL afterward. */
export async function uploadConversationFile(conversationId: string, file: File): Promise<ApiAttachment> {
  const conversation = useConversations.getState().list.find(c => c.id === conversationId)
  const projectId = conversation?.kind === 'group' ? conversation.projectId : null
  const companyId = getActiveCompanyId()
  const current = () => getActiveCompanyId() === companyId && useConversations.getState().list.some(c => c.id === conversationId && (c.projectId ?? null) === (projectId ?? null))
  if (!projectId || !(await projectFilesApi.capabilities()).enabled) {
    if (!current()) throw new Error('The group project changed. Select the attachment again.')
    return api.uploadFile(file)
  }
  const listing = await projectFilesApi.list(projectId)
  if (file.size > listing.maxFileBytes) throw new Error('Single project files are limited to 25 MiB.')
  if (!current()) throw new Error('The group project changed. Select the attachment again.')
  // Uploading an attachment never implicitly overwrites someone else's file.
  const existing = new Set(listing.entries.map(e => e.name))
  const name = existing.has(file.name) ? `${file.name.slice(0, 120)} (${crypto.randomUUID().slice(0, 8)})` : file.name
  const content = await fileAsBase64(file)
  if (!current()) throw new Error('The group project changed. Select the attachment again.')
  const saved = await projectFilesApi.operation(projectId, listing.bindingVersion, { type: 'upload', parentId: 'root', name, content })
  if (!saved.entry) throw new Error('The project file was not saved.')
  if (!current()) throw new Error('The file was saved in the previous project. The group project changed before sending.')
  return projectFileAttachment(projectId, saved.entry)
}

export function saveDownloadedBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
