import { createHash, randomUUID } from 'node:crypto'
import type { LocalProjectObjects } from './objects.js'
import {
  checkRevision, childNamed, depth, descendants, directory, entry, expireWrites, fail, newEntry, own,
  PROJECT_FILE_MAX_BYTES, PROJECT_MAX_DEPTH, PROJECT_MAX_VERSIONS, PROJECT_QUOTA_BYTES, recordEvent, referencedObjects,
  reservedBytes, touch, validName, viewEntry, WRITE_TTL_MS,
  type FileActor, type FileVersion, type FileWrite, type ProjectEntry, type ProjectFileState,
} from './model.js'

export interface FileScope {
  projectId: string; actor: FileActor; admin: boolean; bindingVersion: string; leaseId: string | null
  readOnly?: boolean; quotaBytes?: number
}
export type FileCommand =
  | { type: 'mkdir'; parentId: string; name: string }
  | { type: 'upload'; parentId: string; name: string; content: string; entryId?: string; expectedVersion?: string }
  | { type: 'move'; entryId: string; expectedRevision: string; parentId: string; name: string; targetId?: string; expectedTargetVersion?: string }
  | { type: 'trash'; entryId: string; expectedRevision: string; recursive?: boolean }
  | { type: 'restore'; entryId: string; expectedRevision: string; parentId: string; name: string }
  | { type: 'purge'; entryId: string; expectedRevision: string; confirm: boolean }
  | { type: 'purge-history'; entryId: string; expectedRevision: string; confirm: boolean }
  | { type: 'purge-missing-history'; confirm: boolean }
  | { type: 'begin-write'; entryId: string; expectedVersion: string | null }
  | { type: 'reserve-write'; writeId: string; size: number }
  | { type: 'commit-write'; writeId: string; content: string }
  | { type: 'abort-write'; writeId: string }

export interface FileTransaction {
  state: ProjectFileState; scope: FileScope
  /** Recheck current authorization before returning content or publishing a write. */
  authorize: () => Promise<void>
}
export interface ProjectFileRepository {
  withProject<T>(projectId: string, work: (tx: FileTransaction) => Promise<T>): Promise<T>
}
export interface FileResult {
  entry?: ReturnType<typeof viewEntry>; write?: { id: string; expectedVersion: string | null; expiresAt: number }
  conflict?: boolean; ok?: boolean
}

/** All mutations, including reservations and metadata reconciliation, execute
 * under a cross-process project lock supplied by the repository. Never export
 * its raw state/objects to an untrusted task. */
export class ProjectFileWorkspace {
  constructor(private repository: ProjectFileRepository, private objects: LocalProjectObjects) {}

  private async reconcile(tx: FileTransaction): Promise<Map<string, number>> {
    expireWrites(tx.state)
    const inventory = await this.objects.inventory(tx.scope.projectId)
    for (const item of Object.values(tx.state.entries)) {
      item.versions = item.versions.filter(version => inventory.get(version.objectId) === version.size)
      if (item.kind === 'file' && item.versionId && !item.versions.some(v => v.id === item.versionId) && !item.missing) {
        item.missing = true
        touch(item, tx.scope.actor)
        recordEvent(tx.state, tx.scope.actor, 'content-missing', item.id)
      }
    }
    for (const write of Object.values(tx.state.writes)) {
      const item = own(tx.state.entries, write.entryId)
      if (!item || item.missing || item.deletedAt || write.bindingVersion !== tx.scope.bindingVersion) delete tx.state.writes[write.id]
    }
    const referenced = referencedObjects(tx.state)
    // A failed/aborted metadata transaction may leave an unpublished binary.
    // The same project lock excludes every publisher, so only unreferenced
    // objects can be collected here. Retained versions and trash remain live.
    for (const objectId of inventory.keys()) if (!referenced.has(objectId)) {
      await this.objects.remove(tx.scope.projectId, objectId)
      inventory.delete(objectId)
    }
    return inventory
  }

  private checkSpace(tx: FileTransaction, inventory: Map<string, number>, bytes: number, exceptWrite?: string): void {
    const used = [...inventory.values()].reduce((a, b) => a + b, 0)
    const reserved = reservedBytes(tx.state, exceptWrite)
    if (used + reserved + bytes > (tx.scope.quotaBytes ?? PROJECT_QUOTA_BYTES)) fail('QUOTA_EXCEEDED', 413, 'Project storage is full, including trash, history and pending writes.')
  }

  async list(projectId: string, parentId = 'root', trash = false) {
    return this.repository.withProject(projectId, async tx => {
      const inventory = await this.reconcile(tx)
      if (!trash) directory(tx.state, parentId)
      const entries = Object.values(tx.state.entries).filter(item => !item.missing && item.id !== 'root' &&
        (trash ? item.trashRoot === item.id : item.parentId === parentId && !item.deletedAt))
      const ancestors = []
      if (!trash) {
        let current: ProjectEntry | undefined = directory(tx.state, parentId)
        while (current) { ancestors.unshift(viewEntry(current)); current = current.parentId ? entry(tx.state, current.parentId) : undefined }
      }
      await tx.authorize()
      return { entries: entries.map(viewEntry).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), ancestors,
        usedBytes: [...inventory.values()].reduce((a, b) => a + b, 0), reservedBytes: reservedBytes(tx.state),
        quotaBytes: tx.scope.quotaBytes ?? PROJECT_QUOTA_BYTES, maxFileBytes: PROJECT_FILE_MAX_BYTES,
        canManage: tx.scope.admin, readOnly: tx.scope.readOnly ?? false, epoch: tx.state.epoch, bindingVersion: tx.scope.bindingVersion,
        unavailableCount: tx.scope.admin ? Object.values(tx.state.entries).filter(e => e.missing).length : 0 }
    })
  }

  async stat(projectId: string, entryId: string) {
    return this.repository.withProject(projectId, async tx => {
      const item = entry(tx.state, entryId)
      if (item.kind === 'file') await this.checkReadable(tx, item)
      await tx.authorize()
      return viewEntry(item)
    })
  }

  private async checkReadable(tx: FileTransaction, item: ProjectEntry, versionId?: string): Promise<void> {
    const version = item.versions.find(v => v.id === (versionId ?? item.versionId))
    if (!version || !await this.objects.available(tx.scope.projectId, version.objectId, version.size)) fail('CONTENT_MISSING', 410, 'This version is no longer available.')
  }

  /** Reauthorize a streamed version without rereading or scanning all objects. */
  async assertReadable(projectId: string, entryId: string, versionId: string): Promise<void> {
    await this.repository.withProject(projectId, async tx => {
      const item = entry(tx.state, entryId)
      await this.checkReadable(tx, item)
      await this.checkReadable(tx, item, versionId)
      await tx.authorize()
    })
  }

  async read(projectId: string, entryId: string, versionId?: string) {
    return this.repository.withProject(projectId, async tx => {
      const item = entry(tx.state, entryId)
      if (item.kind !== 'file') fail('IS_DIRECTORY', 400, 'Cannot read a directory as a file.')
      await this.checkReadable(tx, item)
      const version = item.versions.find(v => v.id === (versionId ?? item.versionId))
      if (!version) fail('CONTENT_MISSING', 410, 'This version is no longer available.')
      const content = await this.objects.read(projectId, version.objectId, version)
      await tx.authorize()
      return { content, name: item.name, versionId: version.id, entry: viewEntry(item) }
    })
  }

  async execute(projectId: string, requestId: string, command: FileCommand): Promise<FileResult> {
    if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(requestId)) fail('INVALID_REQUEST_ID', 400, 'An idempotency key of 8–100 safe characters is required.')
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex')
    return this.repository.withProject(projectId, async tx => {
      if (tx.scope.readOnly) fail('READ_ONLY', 409, 'This project is archived or changing its group binding.')
      const lightweight = ['begin-write', 'reserve-write', 'abort-write'].includes(command.type)
      // Reservations do not publish binary data. Existing metadata is a safe
      // (possibly conservative after disk loss) quota estimate until a list or
      // commit reconciles it. Avoid scanning thousands of objects per write().
      expireWrites(tx.state)
      const inventory = lightweight ? new Map([...referencedObjects(tx.state)].map(([id, version]) => [id, version.size])) : await this.reconcile(tx)
      const receiptKey = `${tx.scope.actor.kind}:${tx.scope.actor.id}:${tx.scope.leaseId ?? 'web'}:${requestId}`
      const prior = own(tx.state.receipts, receiptKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409, 'This request ID was already used for another operation.')
        const priorEntry = (prior.result as FileResult).entry
        if (priorEntry && (!own(tx.state.entries, priorEntry.id) || tx.state.entries[priorEntry.id].missing)) fail('CONTENT_MISSING', 410, 'The operation completed previously, but its file is no longer available.')
        await tx.authorize()
        return prior.result as FileResult
      }
      if (Object.keys(tx.state.receipts).length >= 10_000) fail('TOO_MANY_REQUESTS', 429, 'Too many file operations; retry later.')
      const result = await this.mutate(tx, inventory, command)
      await tx.authorize()
      tx.state.receipts[receiptKey] = { fingerprint, result, at: Date.now() }
      return result
    })
  }

  private decode(content: string): Buffer {
    if (typeof content !== 'string' || content.length > Math.ceil(PROJECT_FILE_MAX_BYTES / 3) * 4 ||
      /[^A-Za-z0-9+/=]/u.test(content)) {
      fail('INVALID_CONTENT', 400, 'Expected base64 file content, at most 25MiB.')
    }
    const result = Buffer.from(content, 'base64')
    if (result.toString('base64') !== content) fail('INVALID_CONTENT', 400, 'Expected canonical base64 file content.')
    if (result.length > PROJECT_FILE_MAX_BYTES) fail('FILE_TOO_LARGE', 413, 'The single-file limit is 25MiB.')
    return result
  }

  private ownedWrite(tx: FileTransaction, id: string): FileWrite {
    const write = own(tx.state.writes, id)
    if (!write || write.actor.id !== tx.scope.actor.id || write.actor.kind !== tx.scope.actor.kind ||
      write.leaseId !== tx.scope.leaseId || write.bindingVersion !== tx.scope.bindingVersion || write.expiresAt <= Date.now()) {
      fail('WRITE_EXPIRED', 409, 'The write session expired or was revoked.')
    }
    entry(tx.state, write.entryId)
    return write
  }

  private async commit(tx: FileTransaction, item: ProjectEntry, content: Buffer, inventory: Map<string, number>, exceptWrite?: string) {
    this.checkSpace(tx, inventory, content.length, exceptWrite)
    this.checkVersionCapacity(tx.state, item)
    const object = await this.objects.put(tx.scope.projectId, content)
    inventory.set(object.objectId, object.size)
    const version: FileVersion = { ...object, id: randomUUID(), createdAt: new Date().toISOString(), actor: tx.scope.actor }
    item.versions.push(version); item.versionId = version.id
    touch(item, tx.scope.actor)
    recordEvent(tx.state, tx.scope.actor, 'write', item.id)
  }

  private checkVersionCapacity(state: ProjectFileState, item: ProjectEntry): void {
    if (item.versions.length >= 1000 || Object.values(state.entries).reduce((n, e) => n + e.versions.length, 0) >= PROJECT_MAX_VERSIONS) fail('VERSION_LIMIT', 409, 'Version limit reached; an administrator can clear history.')
  }

  private async mutate(tx: FileTransaction, inventory: Map<string, number>, command: FileCommand): Promise<FileResult> {
    const { state, scope } = tx
    switch (command.type) {
      case 'purge-missing-history': {
        if (!scope.admin || scope.actor.kind !== 'human' || command.confirm !== true) fail('ADMIN_REQUIRED', 403, 'A human administrator must confirm permanent cleanup.')
        const lost = Object.values(state.entries).filter(e => e.missing)
        for (const item of lost) {
          delete state.entries[item.id]
          recordEvent(state, scope.actor, 'purge-missing-history', item.id)
        }
        const retained = referencedObjects(state)
        for (const item of lost) for (const version of item.versions) if (!retained.has(version.objectId)) await this.objects.remove(scope.projectId, version.objectId)
        return { ok: true }
      }
      case 'mkdir': return { entry: viewEntry(newEntry(state, scope.actor, command.parentId, command.name, 'directory')) }
      case 'upload': {
        const bytes = this.decode(command.content)
        const item = command.entryId ? entry(state, command.entryId) : newEntry(state, scope.actor, command.parentId, command.name, 'file')
        if (item.kind !== 'file') fail('IS_DIRECTORY', 400, 'Cannot overwrite a directory.')
        if (command.entryId && (!command.expectedVersion || item.versionId !== command.expectedVersion)) fail('CONFLICT', 409, 'The file changed; upload a separate copy or refresh.')
        await this.commit(tx, item, bytes, inventory)
        return { entry: viewEntry(item) }
      }
      case 'begin-write': {
        const item = entry(state, command.entryId)
        if (item.kind !== 'file') fail('IS_DIRECTORY', 400, 'Cannot open a directory for writing.')
        if (item.versionId !== command.expectedVersion) fail('CONFLICT', 409, 'The file changed before it was opened.')
        if (Object.keys(state.writes).length >= 64) fail('TOO_MANY_WRITES', 429, 'Too many pending project writes.')
        const write: FileWrite = { id: randomUUID(), entryId: item.id, expectedVersion: item.versionId,
          reserved: 0, actor: scope.actor, leaseId: scope.leaseId, bindingVersion: scope.bindingVersion, expiresAt: Date.now() + WRITE_TTL_MS }
        state.writes[write.id] = write
        return { write: { id: write.id, expectedVersion: write.expectedVersion, expiresAt: write.expiresAt } }
      }
      case 'reserve-write': {
        const write = this.ownedWrite(tx, command.writeId)
        if (!Number.isSafeInteger(command.size) || command.size < 0 || command.size > PROJECT_FILE_MAX_BYTES) fail('FILE_TOO_LARGE', 413, 'The single-file limit is 25MiB.')
        this.checkSpace(tx, inventory, command.size, write.id)
        write.reserved = command.size; write.expiresAt = Date.now() + WRITE_TTL_MS
        return { ok: true }
      }
      case 'commit-write': {
        const write = this.ownedWrite(tx, command.writeId)
        const bytes = this.decode(command.content)
        if (bytes.length > write.reserved) fail('RESERVATION_REQUIRED', 409, 'Reserve storage before submitting file content.')
        const original = entry(state, write.entryId)
        let item = original
        const conflict = original.versionId !== write.expectedVersion
        if (conflict) {
          const suffix = ` (conflict-${randomUUID().slice(0, 8)})`
          let base = original.name
          while (Buffer.byteLength(base + suffix) > 255) base = Array.from(base).slice(0, -1).join('')
          item = newEntry(state, scope.actor, original.parentId!, base + suffix, 'file')
        }
        await this.commit(tx, item, bytes, inventory, write.id)
        delete state.writes[write.id]
        if (conflict) recordEvent(state, scope.actor, 'conflict-copy', item.id)
        return { entry: viewEntry(item), conflict }
      }
      case 'abort-write': {
        this.ownedWrite(tx, command.writeId)
        delete state.writes[command.writeId]
        return { ok: true }
      }
      case 'move': {
        const item = entry(state, command.entryId)
        if (item.id === 'root') fail('ROOT_PROTECTED', 400, 'The project root cannot be moved.')
        checkRevision(item, command.expectedRevision)
        directory(state, command.parentId)
        const name = validName(command.name)
        const subtree = descendants(state, item.id)
        if (subtree.some(child => child.id === command.parentId)) fail('DIRECTORY_CYCLE', 400, 'A directory cannot be moved into itself.')
        const maxRelative = Math.max(...subtree.map(child => depth(state, child.parentId!) - depth(state, item.parentId!)))
        if (depth(state, command.parentId) + maxRelative > PROJECT_MAX_DEPTH) fail('DEPTH_LIMIT', 400, 'Maximum directory depth exceeded.')
        const target = childNamed(state, command.parentId, name)
        if (target?.id === item.id) return { entry: viewEntry(item) }
        if (target) {
          // Temp-file rename is a versioned replacement of the target identity.
          // Never infer an expected target version at rename time.
          if (item.kind !== 'file' || target.kind !== 'file') fail('ALREADY_EXISTS', 409, 'The destination already exists.')
          if (command.targetId !== target.id || !command.expectedTargetVersion || target.versionId !== command.expectedTargetVersion) fail('CONFLICT', 409, 'The replacement target changed or was not read; the temporary file has been kept.')
          if (Object.values(state.writes).some(write => write.entryId === item.id)) fail('WRITE_PENDING', 409, 'Flush and close the temporary file before replacing the target.')
          const version = item.versions.find(v => v.id === item.versionId)
          if (!version) fail('CONTENT_MISSING', 410, 'The temporary file is unavailable.')
          this.checkVersionCapacity(state, target)
          const replacement = { ...version, id: randomUUID(), actor: scope.actor, createdAt: new Date().toISOString() }
          target.versions.push(replacement); target.versionId = replacement.id; touch(target, scope.actor)
          this.trash(tx, item, false)
          recordEvent(state, scope.actor, 'replace', target.id)
          return { entry: viewEntry(target) }
        }
        if (command.targetId) fail('CONFLICT', 409, 'The replacement target was removed or renamed.')
        item.parentId = command.parentId; item.name = name; touch(item, scope.actor)
        recordEvent(state, scope.actor, 'move', item.id)
        return { entry: viewEntry(item) }
      }
      case 'trash': {
        const item = entry(state, command.entryId); checkRevision(item, command.expectedRevision)
        this.trash(tx, item, command.recursive === true)
        return { ok: true }
      }
      case 'restore': {
        const item = entry(state, command.entryId, true); checkRevision(item, command.expectedRevision)
        if (item.trashRoot !== item.id) fail('NOT_TRASH_ROOT', 409, 'Restore the containing deleted folder first.')
        directory(state, command.parentId)
        const name = validName(command.name)
        if (childNamed(state, command.parentId, name)) fail('ALREADY_EXISTS', 409, 'A file already uses that name; restore under another name.')
        const subtree = descendants(state, item.id)
        if (subtree.some(child => child.id === command.parentId)) fail('DIRECTORY_CYCLE', 400, 'Invalid restore destination.')
        const oldDepth = this.trashDepth(state, item)
        const maxRelative = Math.max(...subtree.map(child => this.trashDepth(state, child) - oldDepth))
        if (depth(state, command.parentId) + maxRelative > PROJECT_MAX_DEPTH) fail('DEPTH_LIMIT', 400, 'Maximum directory depth exceeded.')
        item.parentId = command.parentId; item.name = name
        for (const child of subtree) if (child.trashRoot === item.id) { child.deletedAt = null; child.trashRoot = null; touch(child, scope.actor) }
        recordEvent(state, scope.actor, 'restore', item.id)
        return { entry: viewEntry(item) }
      }
      case 'purge':
      case 'purge-history': {
        if (!scope.admin || scope.actor.kind !== 'human') fail('ADMIN_REQUIRED', 403, 'Only a human administrator may permanently clear project files.')
        if (command.confirm !== true) fail('CONFIRM_REQUIRED', 400, 'Permanent deletion requires confirmation.')
        // Missing files remain clearable by admins even when their contents are lost.
        const item = own(state.entries, command.entryId)
        if (!item || item.id === 'root') fail('NOT_FOUND', 404, 'File not found.')
        checkRevision(item, command.expectedRevision)
        if (command.type === 'purge') {
          if (!item.deletedAt && !item.missing) fail('NOT_IN_TRASH', 409, 'Move the item to trash before permanent deletion.')
          for (const child of descendants(state, item.id)) delete state.entries[child.id]
        } else {
          item.versions = item.versions.filter(version => version.id === item.versionId)
          touch(item, scope.actor)
        }
        const referenced = referencedObjects(state)
        // The project lock also excludes other writers publishing new objects.
        // Bytes are released only after physical deletion succeeds.
        for (const objectId of inventory.keys()) if (!referenced.has(objectId)) await this.objects.remove(scope.projectId, objectId)
        recordEvent(state, scope.actor, command.type, item.id)
        return { ok: true }
      }
      default: return fail('INVALID_OPERATION', 400, 'Unknown project file operation.')
    }
  }

  private trashDepth(state: ProjectFileState, item: ProjectEntry): number {
    let n = 0
    while (item.parentId) {
      if (++n > PROJECT_MAX_DEPTH) fail('INVALID_TREE', 500, 'Invalid directory tree.')
      const parent = own(state.entries, item.parentId)
      if (!parent) break
      item = parent
    }
    return n
  }

  private trash(tx: FileTransaction, item: ProjectEntry, recursive: boolean): void {
    if (item.id === 'root') fail('ROOT_PROTECTED', 400, 'The project root cannot be removed.')
    const subtree = descendants(tx.state, item.id)
    if (!recursive && subtree.some(child => child.id !== item.id && !child.deletedAt && !child.missing)) fail('DIRECTORY_NOT_EMPTY', 409, 'Directory is not empty.')
    for (const child of subtree) if (!child.deletedAt) {
      child.deletedAt = new Date().toISOString(); child.trashRoot = item.id; touch(child, tx.scope.actor)
      for (const write of Object.values(tx.state.writes)) if (write.entryId === child.id) delete tx.state.writes[write.id]
    }
    recordEvent(tx.state, tx.scope.actor, 'trash', item.id)
  }
}
