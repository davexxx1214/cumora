export const WORKFLOW_STATUSES = ['todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'] as const
export type WorkItemStatus = typeof WORKFLOW_STATUSES[number]

export const WORK_ITEM_TYPES = ['user_story', 'defect', 'subtask'] as const
export type WorkItemType = typeof WORK_ITEM_TYPES[number]

export const WORK_ITEM_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
export type WorkItemPriority = typeof WORK_ITEM_PRIORITIES[number]

export const DEFECT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export const DEFECT_RESOLUTIONS = ['fixed', 'duplicate', 'cannot_reproduce', 'wont_fix'] as const

export class ProjectWorkflowError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public detail?: Record<string, unknown>,
  ) { super(message) }
}

export function workflowFail(code: string, status: number, message: string, detail?: Record<string, unknown>): never {
  throw new ProjectWorkflowError(code, status, message, detail)
}

export function oneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

export interface ProjectWorkflowRecord {
  id: string
  projectId: string
  companyId: string
  issuePrefix: string
  nextNumber: number
  status: 'active' | 'closed'
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface ProjectWorkItemRecord {
  id: string
  workflowId: string
  projectId: string
  issueNumber: number
  issueKey: string
  type: WorkItemType
  parentId: string | null
  title: string
  description: string
  status: WorkItemStatus
  priority: WorkItemPriority
  assigneeId: string | null
  assigneeKind: 'human' | 'agent' | null
  reporterId: string
  labels: string[]
  dueAt: string | null
  rank: number
  version: number
  userValue: string | null
  acceptanceCriteria: string | null
  storyPoints: number | null
  severity: typeof DEFECT_SEVERITIES[number] | null
  reproductionSteps: string | null
  expectedResult: string | null
  actualResult: string | null
  environment: string | null
  resolution: typeof DEFECT_RESOLUTIONS[number] | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  subtaskDone: number
  subtaskTotal: number
}

export type WorkflowEventKind =
  | 'workflow.created' | 'workflow.updated' | 'workflow.closed' | 'workflow.reopened'
  | 'item.created' | 'item.updated' | 'item.assigned' | 'item.status_changed'
  | 'item.archived' | 'item.restored' | 'item.deleted' | 'item.force_completed'
  | 'comment.created' | 'comment.deleted'
  | 'file_link.created' | 'file_link.deleted'
  | 'commit_link.created' | 'commit_link.deleted'
  | 'agent.execution_requested'

export interface ProjectWorkflowChangedEvent {
  type: 'project.workflow_changed'
  companyId: string
  conversationId: string
  projectId: string
  workflowId: string
  kind: WorkflowEventKind
  itemId?: string
  actorId: string
  notificationRecipientIds?: string[]
}
