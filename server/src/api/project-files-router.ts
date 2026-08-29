import { Router, type Request, type Response, type NextFunction } from 'express'
import type { AuthedRequest } from '../auth.js'
import { pool } from '../db/pool.js'
import { PROJECT_FILE_MAX_BYTES, ProjectFileError, fail } from '../project-files/model.js'
import { storage, storageKeyFromPublicUrl, type StoredAttachment } from '../storage.js'
import { filesEnabled, projectFilesFor } from '../project-files/service.js'
import type { FileCommand } from '../project-files/workspace.js'

export function projectFileHandler(handler: (req: Request & AuthedRequest, res: Response) => Promise<void>) {
  return async (req: Request & AuthedRequest, res: Response, next: NextFunction) => {
    try { await handler(req, res) } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      if (error instanceof ProjectFileError) res.status(error.status).json({ code: error.code, error: error.message })
      else next(error)
    }
  }
}
export const projectFilesRouter = Router()

async function identity(req: Request & AuthedRequest, mutation = false) {
  if (!req.authUserId) fail('UNAUTHENTICATED', 401, 'Authentication required.')
  let companyId = typeof req.headers['x-company-id'] === 'string' ? req.headers['x-company-id'].trim() : ''
  if (!companyId) {
    const { rows } = await pool.query<{ company_id: string }>('SELECT company_id FROM company_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1', [req.authUserId])
    companyId = rows[0]?.company_id ?? ''
  }
  const bindingVersion = mutation && typeof req.body?.bindingVersion === 'string' ? req.body.bindingVersion : undefined
  if (mutation && !bindingVersion) fail('BINDING_REQUIRED', 400, 'Select a current project before changing files.')
  return { kind: 'human' as const, id: req.authUserId, companyId, bindingVersion }
}
projectFilesRouter.get('/capabilities', projectFileHandler(async (req, res) => {
  await identity(req)
  res.json({ enabled: filesEnabled() })
}))
projectFilesRouter.get('/:projectId/entries', projectFileHandler(async (req, res) => {
  const service = projectFilesFor(await identity(req))
  res.set('Cache-Control', 'no-store').json(await service.list(String(req.params.projectId), String(req.query.parentId ?? 'root'), req.query.trash === '1'))
}))
projectFilesRouter.get('/:projectId/entries/:entryId', projectFileHandler(async (req, res) => {
  const service = projectFilesFor(await identity(req))
  res.set('Cache-Control', 'no-store').json(await service.stat(String(req.params.projectId), String(req.params.entryId)))
}))
projectFilesRouter.post('/:projectId/operations', projectFileHandler(async (req, res) => {
  const service = projectFilesFor(await identity(req, true))
  const command = req.body?.command
  if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.type !== 'string') fail('INVALID_OPERATION', 400, 'File operation required.')
  const result = await service.execute(String(req.params.projectId), String(req.body?.requestId ?? ''), command as FileCommand)
  // A conflict copy is committed successfully, but callers must still report
  // that the original save did not succeed (FUSE maps this to ESTALE).
  res.status(result.conflict ? 409 : 200).json(result)
}))
projectFilesRouter.post('/:projectId/save-attachment', projectFileHandler(async (req, res) => {
  const actor = await identity(req, true)
  const projectId = String(req.params.projectId)
  const service = projectFilesFor(actor)
  await service.stat(projectId, 'root')
  const { rows } = await pool.query<{ attachment: StoredAttachment }>(`SELECT m.attachment FROM messages m
    JOIN conversations c ON c.id=m.conversation_id
    WHERE m.id=$1 AND c.id=$2 AND c.company_id=$3 AND c.project_id=$4 AND c.members @> $5::jsonb`,
    [req.body?.messageId, req.body?.conversationId, actor.companyId, projectId, JSON.stringify([actor.id])])
  const attachment = rows[0]?.attachment
  if (!attachment) fail('NOT_FOUND', 404, 'Chat attachment not found.')
  let content: Buffer
  if (attachment.projectFile) {
    const ref = attachment.projectFile
    content = (await service.read(ref.projectId, ref.entryId, ref.versionId)).content
  } else {
    const key = attachment.key ?? storageKeyFromPublicUrl(attachment.url)
    if (!key) fail('UNSUPPORTED_ATTACHMENT', 400, 'This attachment is an external link. Upload the file directly instead.')
    content = await storage.read(key, PROJECT_FILE_MAX_BYTES)
  }
  res.json(await service.execute(projectId, String(req.body?.requestId ?? ''), { type: 'upload', parentId: String(req.body?.parentId ?? 'root'),
    name: String(req.body?.name ?? attachment.name), content: content.toString('base64') }))
}))
projectFilesRouter.get('/:projectId/entries/:entryId/download', projectFileHandler(async (req, res) => {
  const service = projectFilesFor(await identity(req))
  // Range and conditional requests never bypass auth. The first version returns
  // a complete authenticated response, without a public URL or partial cache.
  const file = await service.read(String(req.params.projectId), String(req.params.entryId), typeof req.query.versionId === 'string' ? req.query.versionId : undefined)
  res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16)}`)}`,
    'Content-Length': String(file.content.length), 'Accept-Ranges': 'none' })
  // Bound bytes queued between authorization checks. A slow or paused
  // download cannot retain access indefinitely after membership is removed.
  const projectId = String(req.params.projectId), entryId = String(req.params.entryId)
  for (let offset = 0; offset < file.content.length; offset += 256 * 1024) {
    if (res.destroyed) return
    await service.assertReadable(projectId, entryId, file.versionId)
    if (!res.write(file.content.subarray(offset, offset + 256 * 1024))) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearInterval(check); res.off('drain', done); res.off('close', done) }
        const done = () => { cleanup(); resolve() }
        let checking = false
        const check = setInterval(() => {
          if (checking) return
          checking = true
          void service.assertReadable(projectId, entryId, file.versionId).catch(error => { cleanup(); reject(error) }).finally(() => { checking = false })
        }, 1000)
        res.once('drain', done); res.once('close', done)
      })
    }
  }
  res.end()
}))
