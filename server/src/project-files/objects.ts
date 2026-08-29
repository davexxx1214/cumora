import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, statfs, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fail, PROJECT_FILE_MAX_BYTES } from './model.js'

const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/
const OBJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const HOST_FREE_FLOOR = 512 * 1024 * 1024
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }

/** Private binary objects, never mounted or served through /uploads. Call only
 * while holding the project's database lock. The task runner must hide this root. */
export class LocalProjectObjects {
  readonly root: string
  constructor(root: string) {
    if (!isAbsolute(root)) fail('CONFIGURATION', 503, 'Project data root must be absolute.')
    this.root = resolve(root)
    if (this.root === parse(this.root).root) fail('CONFIGURATION', 503, 'A filesystem root cannot be used as the project data root.')
  }
  private path(projectId: string, objectId?: string): string {
    if (!SAFE_ID.test(projectId) || (objectId !== undefined && !OBJECT_ID.test(objectId))) fail('INVALID_ID', 400, 'Invalid storage identifier.')
    return objectId ? join(this.root, projectId, objectId) : join(this.root, projectId)
  }
  async ensure(projectId: string): Promise<string> {
    const dir = this.path(projectId)
    // The configured root and each existing ancestor must not be a symlink.
    const parts = relative(parse(dir).root, dir).split(/[\\/]/u).filter(Boolean)
    let current = parse(dir).root
    for (const part of parts) {
      current = join(current, part)
      try { await mkdir(current, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_STORAGE', 503, 'The project data path must contain only real directories.')
      if (process.platform !== 'win32' && (current === this.root || current === dir) &&
          ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
        fail('UNSAFE_STORAGE', 503, 'The private project data root and project directories must be owned by this service with mode 0700.')
      }
    }
    if (resolve(await realpath(dir)) !== dir) fail('UNSAFE_STORAGE', 503, 'The project data root resolves outside the configured path.')
    return dir
  }
  async inventory(projectId: string): Promise<Map<string, number>> {
    const dir = await this.ensure(projectId)
    const result = new Map<string, number>()
    for (const name of await readdir(dir)) {
      if (!OBJECT_ID.test(name)) fail('UNSAFE_STORAGE', 503, 'Unexpected entry in the private object directory.')
      try {
        const stat = await lstat(this.path(projectId, name))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_STORAGE', 503, 'Only unlinked regular objects are supported.')
        result.set(name, stat.size)
      } catch (error) { if (!isMissing(error)) throw error }
    }
    return result
  }
  async available(projectId: string, objectId: string, expectedSize: number): Promise<boolean> {
    await this.ensure(projectId)
    try {
      const info = await lstat(this.path(projectId, objectId))
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_STORAGE', 503, 'Unsupported object type.')
      return info.size === expectedSize
    } catch (error) { if (isMissing(error)) return false; throw error }
  }
  async put(projectId: string, content: Buffer): Promise<{ objectId: string; size: number; sha256: string }> {
    if (content.length > PROJECT_FILE_MAX_BYTES) fail('FILE_TOO_LARGE', 413, 'The single-file limit is 25MiB.')
    const directory = await this.ensure(projectId)
    const disk = await statfs(directory)
    if (disk.bavail * disk.bsize < HOST_FREE_FLOOR + content.length) fail('HOST_DISK_FULL', 507, 'The host has less than 512 MiB of safe free space. Writes are paused.')
    const objectId = randomUUID()
    const target = this.path(projectId, objectId)
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    try { await handle.writeFile(content); await handle.sync() } catch (error) {
      await handle.close(); await unlink(target).catch(() => {}); throw error
    }
    await handle.close()
    await this.syncDirectory(directory)
    return { objectId, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
  }
  async read(projectId: string, objectId: string, expected: { size: number; sha256: string }): Promise<Buffer> {
    await this.ensure(projectId)
    let handle
    try { handle = await open(this.path(projectId, objectId), constants.O_RDONLY | NOFOLLOW) } catch (error) {
      if (isMissing(error)) fail('CONTENT_MISSING', 410, 'The file is no longer present on this host.')
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_STORAGE', 503, 'Unsupported object type.')
      if (stat.size !== expected.size || stat.size > PROJECT_FILE_MAX_BYTES) fail('CONTENT_MISSING', 410, 'The file content has changed outside the file service.')
      const bytes = await handle.readFile()
      if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) fail('CONTENT_MISSING', 410, 'The file content has changed outside the file service.')
      return bytes
    } finally { await handle.close() }
  }
  async remove(projectId: string, objectId: string): Promise<void> {
    const directory = await this.ensure(projectId)
    try { await unlink(this.path(projectId, objectId)) } catch (error) { if (!isMissing(error)) throw error }
    await this.syncDirectory(directory)
  }
  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') return // only the Linux host is a deployment target
    const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
    try { await handle.sync() } finally { await handle.close() }
  }
}
