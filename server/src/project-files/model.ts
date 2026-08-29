import { randomUUID } from 'node:crypto'

export const PROJECT_QUOTA_BYTES = 5_000_000_000
export const PROJECT_FILE_MAX_BYTES = 25 * 1024 * 1024
export const PROJECT_MAX_ENTRIES = 5000
export const PROJECT_MAX_VERSIONS = 10_000
export const PROJECT_MAX_DEPTH = 32
export const WRITE_TTL_MS = 15 * 60_000

export class ProjectFileError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message) }
}
export function fail(code: string, status: number, message: string): never { throw new ProjectFileError(code, status, message) }
export interface FileActor { id: string; kind: 'human' | 'agent'; name: string }
export interface ProjectFileReference { projectId: string; entryId: string; versionId: string; name: string }
export interface FileVersion {
  id: string; objectId: string; size: number; sha256: string; createdAt: string; actor: FileActor
}
export interface ProjectEntry {
  id: string; parentId: string | null; name: string; kind: 'file' | 'directory'
  revision: string; versionId: string | null; versions: FileVersion[]
  modifiedAt: string; modifiedBy: FileActor; deletedAt: string | null
  /** The root of a recursively trashed tree. Children retain their parent IDs. */
  trashRoot: string | null; missing: boolean
}
export interface FileWrite {
  id: string; entryId: string; expectedVersion: string | null; reserved: number
  actor: FileActor; leaseId: string | null; bindingVersion: string
  expiresAt: number
}
export interface FileReceipt { fingerprint: string; result: unknown; at: number }
export interface ProjectFileState {
  schema: 1; epoch: string; entries: Record<string, ProjectEntry>; writes: Record<string, FileWrite>
  receipts: Record<string, FileReceipt>
  events: Array<{ id: string; at: string; actor: FileActor; action: string; entryId: string }>
}
export const SYSTEM_ACTOR: FileActor = { id: 'system', kind: 'human', name: 'System' }
export function emptyProjectState(): ProjectFileState {
  return { schema: 1, epoch: randomUUID(), entries: {
    root: { id: 'root', parentId: null, name: '', kind: 'directory', revision: randomUUID(), versionId: null,
      versions: [], modifiedAt: new Date().toISOString(), modifiedBy: SYSTEM_ACTOR, deletedAt: null, trashRoot: null, missing: false },
  }, writes: {}, receipts: {}, events: [] }
}

export function validName(value: unknown): string {
  if (typeof value === 'string') value = value.normalize('NFC')
  if (typeof value !== 'string' || !value || value === '.' || value === '..' ||
      /[\x00-\x1f\x7f/\\]/u.test(value) || Buffer.byteLength(value, 'utf8') > 255) {
    fail('INVALID_NAME', 400, 'Use a name of 1–255 UTF-8 bytes without slashes or control characters.')
  }
  return value
}
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
export function entry(state: ProjectFileState, id: string, includeTrash = false): ProjectEntry {
  const item = own(state.entries, id)
  if (!item || item.missing || (!includeTrash && item.deletedAt)) fail('NOT_FOUND', 404, 'File or directory is unavailable.')
  let parent = item.parentId
  for (let depth = 0; parent; depth++) {
    const ancestor = own(state.entries, parent)
    if (depth >= PROJECT_MAX_DEPTH || !ancestor || ancestor.missing || (!includeTrash && ancestor.deletedAt)) {
      fail('NOT_FOUND', 404, 'The parent directory is unavailable.')
    }
    parent = ancestor.parentId
  }
  return item
}
export function directory(state: ProjectFileState, id: string): ProjectEntry {
  const item = entry(state, id)
  if (item.kind !== 'directory') fail('NOT_DIRECTORY', 400, 'The destination must be a directory.')
  return item
}
export function checkRevision(item: ProjectEntry, expected: unknown): void {
  if (typeof expected !== 'string' || expected !== item.revision) fail('CONFLICT', 409, 'The file or directory changed. Refresh before retrying.')
}
export function childNamed(state: ProjectFileState, parentId: string, name: string): ProjectEntry | undefined {
  return Object.values(state.entries).find(item => item.parentId === parentId && item.name === name && !item.deletedAt && !item.missing)
}
export function descendants(state: ProjectFileState, id: string): ProjectEntry[] {
  const result: ProjectEntry[] = []
  const pending = [id]
  const seen = new Set<string>()
  while (pending.length) {
    const parent = pending.pop()!
    if (seen.has(parent)) fail('INVALID_TREE', 500, 'Invalid project directory tree.')
    seen.add(parent)
    const item = own(state.entries, parent)
    if (item) result.push(item)
    for (const child of Object.values(state.entries)) if (child.parentId === parent) pending.push(child.id)
  }
  return result
}
export function depth(state: ProjectFileState, parentId: string): number {
  let n = 0
  let current: string | null = parentId
  while (current) {
    if (++n > PROJECT_MAX_DEPTH) fail('DEPTH_LIMIT', 400, 'Maximum directory depth exceeded.')
    current = entry(state, current).parentId
  }
  return n
}
export function touch(item: ProjectEntry, actor: FileActor): void {
  item.revision = randomUUID(); item.modifiedAt = new Date().toISOString(); item.modifiedBy = actor
}
export function recordEvent(state: ProjectFileState, actor: FileActor, action: string, entryId: string): void {
  state.events.push({ id: randomUUID(), at: new Date().toISOString(), actor, action, entryId })
  // Operational history, not a backup or an unbounded file-content log.
  if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000)
}
export function newEntry(state: ProjectFileState, actor: FileActor, parentId: string, name: string, kind: ProjectEntry['kind']): ProjectEntry {
  directory(state, parentId); name = validName(name); depth(state, parentId)
  if (childNamed(state, parentId, name)) fail('ALREADY_EXISTS', 409, 'A file or directory already uses that name.')
  if (Object.keys(state.entries).length >= PROJECT_MAX_ENTRIES) fail('ENTRY_LIMIT', 409, 'Project entry limit reached; an administrator can clear trash or unavailable file history.')
  const item: ProjectEntry = { id: randomUUID(), parentId, name, kind, revision: randomUUID(), versionId: null,
    versions: [], modifiedAt: new Date().toISOString(), modifiedBy: actor, deletedAt: null, trashRoot: null, missing: false }
  state.entries[item.id] = item
  recordEvent(state, actor, 'create', item.id)
  return item
}
export function referencedObjects(state: ProjectFileState): Map<string, FileVersion> {
  const versions = new Map<string, FileVersion>()
  for (const item of Object.values(state.entries)) for (const version of item.versions) versions.set(version.objectId, version)
  return versions
}
export function reservedBytes(state: ProjectFileState, except?: string): number {
  return Object.values(state.writes).reduce((sum, write) => sum + (write.id === except ? 0 : write.reserved), 0)
}
export function expireWrites(state: ProjectFileState, now = Date.now()): void {
  for (const write of Object.values(state.writes)) if (write.expiresAt <= now) delete state.writes[write.id]
  for (const [key, value] of Object.entries(state.receipts)) if (value.at + 24 * 60 * 60_000 < now) delete state.receipts[key]
}
export function viewEntry(item: ProjectEntry) {
  const version = item.versions.find(v => v.id === item.versionId)
  return { id: item.id, parentId: item.parentId, name: item.name, kind: item.kind, revision: item.revision,
    versionId: item.versionId, size: version?.size ?? 0, modifiedAt: item.modifiedAt, modifiedBy: item.modifiedBy,
    deletedAt: item.deletedAt, trashRoot: item.trashRoot }
}
