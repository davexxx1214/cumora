import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { normalizeStorageKey } from './storage-keys.js'

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Read a server-managed local attachment without following a path outside
 * the upload root. Lexical containment alone is insufficient because a path
 * component inside the root may be a symbolic link. Resolve both paths to
 * their physical locations, then open the verified canonical path so the
 * original link is never used for the read. */
export async function readLocalMessageAttachment(
  uploadDir: string,
  rawKey: string,
): Promise<Buffer | null> {
  const key = normalizeStorageKey(rawKey)
  if (!key?.startsWith('attachments/')) return null

  const lexicalRoot = resolve(uploadDir)
  const lexicalCandidate = resolve(lexicalRoot, key)
  if (!isWithin(lexicalRoot, lexicalCandidate)) return null

  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const [physicalRoot, physicalCandidate] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalCandidate),
    ])
    if (!isWithin(physicalRoot, physicalCandidate)) return null

    // O_NOFOLLOW fails closed on platforms that expose it if the final
    // component is replaced with a link between realpath() and open().
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(physicalCandidate, constants.O_RDONLY | noFollow)
    const metadata = await handle.stat()
    if (!metadata.isFile()) return null
    return await handle.readFile()
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
