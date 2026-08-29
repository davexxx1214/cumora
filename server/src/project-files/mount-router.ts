import { Router, type Request } from 'express'
import { projectFileHandler } from '../api/project-files-router.js'
import { fail } from './model.js'
import { heartbeatProjectLease, projectFilesFor } from './service.js'
import type { FileCommand } from './workspace.js'
import { runProjectCli } from './scoped-cli.js'

/** Narrow lease-only endpoint, separate from the general Agent runtime token. */
export const projectMountRouter = Router()
function token(req: Request): string {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) fail('REVOKED', 403, 'A project lease is required.')
  return header.slice(7)
}
projectMountRouter.post('/heartbeat', projectFileHandler(async (req, res) => {
  res.json(await heartbeatProjectLease(token(req)))
}))
projectMountRouter.post('/cli', projectFileHandler(async (req, res) => {
  res.json(await runProjectCli(token(req), req.body?.argv))
}))
projectMountRouter.get('/:projectId/list', projectFileHandler(async (req, res) => {
  const service = projectFilesFor({ kind: 'lease', token: token(req) })
  res.set('Cache-Control', 'no-store').json(await service.list(String(req.params.projectId), String(req.query.parentId ?? 'root')))
}))
projectMountRouter.get('/:projectId/stat/:entryId', projectFileHandler(async (req, res) => {
  const service = projectFilesFor({ kind: 'lease', token: token(req) })
  res.set('Cache-Control', 'no-store').json(await service.stat(String(req.params.projectId), String(req.params.entryId)))
}))
projectMountRouter.get('/:projectId/read/:entryId', projectFileHandler(async (req, res) => {
  const service = projectFilesFor({ kind: 'lease', token: token(req) })
  const result = await service.read(String(req.params.projectId), String(req.params.entryId), typeof req.query.versionId === 'string' ? req.query.versionId : undefined)
  res.set('Cache-Control', 'no-store').json({ entry: result.entry, content: result.content.toString('base64') })
}))
projectMountRouter.post('/:projectId/operations', projectFileHandler(async (req, res) => {
  const service = projectFilesFor({ kind: 'lease', token: token(req) })
  if (!req.body?.command || typeof req.body.command.type !== 'string') fail('INVALID_OPERATION', 400, 'File command required.')
  const result = await service.execute(String(req.params.projectId), String(req.body.requestId ?? ''), req.body.command as FileCommand)
  res.status(result.conflict ? 409 : 200).json(result)
}))
