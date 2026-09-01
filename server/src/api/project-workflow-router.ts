import { type NextFunction, type Request, type Response, Router } from 'express'
import type { AuthedRequest } from '../auth.js'
import { env } from '../env.js'
import { type ProjectWorkflowChangedEvent, ProjectWorkflowError, type WorkflowEventKind } from '../project-workflow/model.js'
import {
  addComment, addCommitLink, addFileLink, createWorkflow, createWorkItem, deleteComment,
  deleteLink, deleteWorkItem, getWorkflow, getWorkItem, listActivity, listComments, listLinks,
  listNotifications, listWorkItems, markNotificationsRead, requestAgentExecution,
  setWorkflowClosed, setWorkItemArchived, updateWorkItem,
} from '../project-workflow/service.js'
import { CH_MESSAGE_NEW, CH_PROJECT_WORKFLOW, publish } from '../redis.js'

type CompanyContext = { userId: string; companyId: string }
export interface ProjectWorkflowRouterDeps {
  requireCompany(req: Request & AuthedRequest): Promise<CompanyContext>
}

function split(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.split(',').map(part => part.trim()).filter(Boolean)
}

function safe(handler: (req: Request & AuthedRequest, res: Response) => Promise<void>) {
  return async (req: Request & AuthedRequest, res: Response, next: NextFunction) => {
    try { await handler(req, res) } catch (error) {
      if (error instanceof ProjectWorkflowError) {
        res.status(error.status).json({ error: error.message, code: error.code, ...(error.detail ?? {}) })
        return
      }
      next(error)
    }
  }
}

async function emit(args: {
  companyId: string; conversationId: string; projectId: string; workflowId: string
  kind: WorkflowEventKind; actorId: string; itemId?: string; notificationRecipientIds?: string[]
}): Promise<void> {
  const event: ProjectWorkflowChangedEvent = { type: 'project.workflow_changed', ...args }
  await publish(CH_PROJECT_WORKFLOW, event).catch((error) => {
    console.warn('[project-workflow] broadcast failed', error)
  })
}

export function createProjectWorkflowRouter(deps: ProjectWorkflowRouterDeps) {
  const router = Router()
  const context = (req: Request & AuthedRequest) => deps.requireCompany(req)

  router.get('/capabilities', safe(async (req, res) => {
    await context(req)
    res.json({ enabled: env.PROJECT_WORKFLOW_ENABLED })
  }))
  router.use((_req, res, next) => {
    if (!env.PROJECT_WORKFLOW_ENABLED) { res.status(503).json({ code: 'WORKFLOW_DISABLED', error: 'Project workflow is disabled on this host.' }); return }
    next()
  })

  router.get('/conversations/:conversationId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    res.set('Cache-Control', 'no-store').json(await getWorkflow(companyId, userId, String(req.params.conversationId)))
  }))

  router.post('/conversations/:conversationId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await createWorkflow(companyId, userId, String(req.params.conversationId), req.body?.issuePrefix)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.workflow.id, kind: 'workflow.created', actorId: userId })
    res.status(201).json(result.workflow)
  }))

  router.patch('/conversations/:conversationId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    if (typeof req.body?.closed !== 'boolean') throw new ProjectWorkflowError('INVALID_STATUS', 400, 'closed must be a boolean.')
    const result = await setWorkflowClosed(companyId, userId, String(req.params.conversationId), req.body.closed)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.workflowId, kind: result.status === 'closed' ? 'workflow.closed' : 'workflow.reopened', actorId: userId })
    res.json({ ok: true, status: result.status })
  }))

  router.get('/conversations/:conversationId/items', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const parent = req.query.parentId === 'root' ? null : typeof req.query.parentId === 'string' ? req.query.parentId : undefined
    res.set('Cache-Control', 'no-store').json(await listWorkItems(companyId, userId, String(req.params.conversationId), {
      types: split(req.query.type), statuses: split(req.query.status), priorities: split(req.query.priority),
      assigneeId: typeof req.query.assigneeId === 'string' ? req.query.assigneeId : undefined,
      label: typeof req.query.label === 'string' ? req.query.label : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      archived: req.query.archived === '1', parentId: parent,
      limit: Number(req.query.limit) || undefined, offset: Number(req.query.offset) || undefined,
    }))
  }))

  router.post('/conversations/:conversationId/items', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await createWorkItem(companyId, userId, String(req.params.conversationId), req.body ?? {})
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: result.eventKind, itemId: result.item.id, actorId: userId,
      notificationRecipientIds: result.notificationRecipientIds })
    res.status(201).json(result.item)
  }))

  router.get('/conversations/:conversationId/items/:itemId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await getWorkItem(companyId, userId, String(req.params.conversationId), String(req.params.itemId))
    res.set('Cache-Control', 'no-store').json(result.item)
  }))

  router.patch('/conversations/:conversationId/items/:itemId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await updateWorkItem(companyId, userId, String(req.params.conversationId), String(req.params.itemId),
      req.body?.expectedVersion, req.body ?? {}, req.body?.forceReason)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: result.eventKind, itemId: result.item.id, actorId: userId,
      notificationRecipientIds: result.notificationRecipientIds })
    res.json(result.item)
  }))

  router.post('/conversations/:conversationId/items/:itemId/archive', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await setWorkItemArchived(companyId, userId, String(req.params.conversationId), String(req.params.itemId),
      req.body?.expectedVersion, req.body?.archived !== false)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: result.eventKind, itemId: result.item.id, actorId: userId })
    res.json(result.item)
  }))

  router.delete('/conversations/:conversationId/items/:itemId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await deleteWorkItem(companyId, userId, String(req.params.conversationId), String(req.params.itemId), req.body?.reason)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: 'item.deleted', itemId: result.itemId, actorId: userId })
    res.json({ ok: true })
  }))

  router.get('/conversations/:conversationId/items/:itemId/comments', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    res.json((await listComments(companyId, userId, String(req.params.conversationId), String(req.params.itemId))).comments)
  }))

  router.post('/conversations/:conversationId/items/:itemId/comments', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await addComment(companyId, userId, String(req.params.conversationId), String(req.params.itemId), req.body?.body)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: 'comment.created', itemId: String(req.params.itemId), actorId: userId,
      notificationRecipientIds: result.notificationRecipientIds })
    res.status(201).json(result.comment)
  }))

  router.delete('/conversations/:conversationId/items/:itemId/comments/:commentId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await deleteComment(companyId, userId, String(req.params.conversationId), String(req.params.itemId), String(req.params.commentId))
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: 'comment.deleted', itemId: String(req.params.itemId), actorId: userId })
    res.json({ ok: true })
  }))

  router.get('/conversations/:conversationId/items/:itemId/activity', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    res.json((await listActivity(companyId, userId, String(req.params.conversationId), String(req.params.itemId))).events)
  }))

  router.get('/conversations/:conversationId/items/:itemId/links', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await listLinks(companyId, userId, String(req.params.conversationId), String(req.params.itemId))
    res.json({ files: result.files, commits: result.commits })
  }))

  router.post('/conversations/:conversationId/items/:itemId/file-links', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await addFileLink(companyId, userId, String(req.params.conversationId), String(req.params.itemId),
      req.body?.entryId, req.body?.versionId, req.body?.name)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: 'file_link.created', itemId: String(req.params.itemId), actorId: userId })
    res.status(201).json(result.link)
  }))

  router.post('/conversations/:conversationId/items/:itemId/commit-links', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await addCommitLink(companyId, userId, String(req.params.conversationId), String(req.params.itemId),
      req.body?.repositoryId, req.body?.commitHash, req.body?.summary)
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: 'commit_link.created', itemId: String(req.params.itemId), actorId: userId })
    res.status(201).json(result.link)
  }))

  router.delete('/conversations/:conversationId/items/:itemId/file-links/:linkId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await deleteLink(companyId, userId, String(req.params.conversationId), String(req.params.itemId), 'file', String(req.params.linkId))
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: 'file_link.deleted', itemId: String(req.params.itemId), actorId: userId })
    res.json({ ok: true })
  }))

  router.delete('/conversations/:conversationId/items/:itemId/commit-links/:linkId', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await deleteLink(companyId, userId, String(req.params.conversationId), String(req.params.itemId), 'commit', String(req.params.linkId))
    await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
      workflowId: result.scope.workflow!.id, kind: 'commit_link.deleted', itemId: String(req.params.itemId), actorId: userId })
    res.json({ ok: true })
  }))

  router.get('/conversations/:conversationId/notifications', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    res.json((await listNotifications(companyId, userId, String(req.params.conversationId), req.query.unread !== '0')).notifications)
  }))

  router.post('/conversations/:conversationId/notifications/read', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    res.json(await markNotificationsRead(companyId, userId, String(req.params.conversationId), req.body?.ids))
  }))

  router.post('/conversations/:conversationId/items/:itemId/execute', safe(async (req, res) => {
    const { userId, companyId } = await context(req)
    const result = await requestAgentExecution(companyId, userId, String(req.params.conversationId), String(req.params.itemId),
      req.body?.idempotencyKey, req.body?.instruction)
    if (result.created) {
      await emit({ companyId, conversationId: result.scope.conversationId, projectId: result.scope.projectId,
        workflowId: result.scope.workflow!.id, kind: 'agent.execution_requested', itemId: result.item.id,
        actorId: userId, notificationRecipientIds: [result.command.agentId] })
      if (result.message) {
        await publish(CH_MESSAGE_NEW, {
          type: 'message.new', companyId, conversationId: result.scope.conversationId,
          message: {
            id: result.message.id, conversationId: result.scope.conversationId, authorId: userId,
            kind: 'text', body: result.message.body, sequence: result.message.sequence,
            at: result.message.at, agentRecipientIds: result.message.agentRecipientIds,
            clientId: `workflow-command:${result.command.id}`,
          },
        })
      }
    }
    res.status(202).json(result.command)
  }))

  return router
}
