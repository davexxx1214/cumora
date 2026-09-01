import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  type ApiProjectGitRepository,
  type ApiProjectWorkflowActivity,
  type ApiProjectWorkflowComment,
  type ApiProjectWorkflowContext,
  type ApiProjectWorkItem,
  type ApiProjectWorkItemCommitLink,
  type ApiProjectWorkItemFileLink,
  api,
  type ProjectWorkItemPriority,
  type ProjectWorkItemStatus,
  type ProjectWorkItemType,
  ws,
} from '@/api/client'
import { type ProjectFileListing, projectFilesApi, saveDownloadedBlob } from '@/api/project-files'
import { useT } from '@/lib/i18n'
import { useAuth, useCanManageWorkspace } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import type { Conversation } from '@/types'

const STATUSES: ProjectWorkItemStatus[] = ['todo','in_progress','blocked','in_review','done','canceled']
const PRIORITIES: ProjectWorkItemPriority[] = ['low','medium','high','critical']
const control = 'rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm outline-none focus:border-skype'
const button = 'rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm font-semibold hover:bg-sky2-50 disabled:cursor-not-allowed disabled:opacity-40'
const primary = 'rounded-lg bg-skype px-4 py-2 text-sm font-semibold text-white hover:bg-skype-deep disabled:cursor-not-allowed disabled:opacity-40'

function statusTone(status: ProjectWorkItemStatus): string {
  return status === 'blocked' ? 'border-red-200 bg-red-50' : status === 'done' ? 'border-green-200 bg-green-50'
    : status === 'in_review' ? 'border-violet-200 bg-violet-50' : status === 'in_progress' ? 'border-sky-200 bg-sky-50' : 'border-ink-100 bg-white'
}

function itemDraft(item: ApiProjectWorkItem) {
  return {
    title: item.title, description: item.description, status: item.status, priority: item.priority,
    assigneeId: item.assigneeId ?? '', labels: item.labels.join(', '), dueAt: item.dueAt?.slice(0, 10) ?? '',
    userValue: item.userValue ?? '', acceptanceCriteria: item.acceptanceCriteria ?? '',
    storyPoints: item.storyPoints == null ? '' : String(item.storyPoints), severity: item.severity ?? '',
    reproductionSteps: item.reproductionSteps ?? '', expectedResult: item.expectedResult ?? '',
    actualResult: item.actualResult ?? '', environment: item.environment ?? '', resolution: item.resolution ?? '',
  }
}

export function ProjectWorkflowDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const t = useT()
  const canManageWorkspace = useCanManageWorkspace()
  const epoch = useRef(useAuth.getState().contextEpoch)
  const dialog = useRef<HTMLDialogElement>(null)
  const sequence = useRef(0)
  const [context, setContext] = useState<ApiProjectWorkflowContext | null>(null)
  const [items, setItems] = useState<ApiProjectWorkItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'board' | 'list'>('board')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | ProjectWorkItemType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | ProjectWorkItemStatus>('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | ProjectWorkItemPriority>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [labelFilter, setLabelFilter] = useState('')
  const [sort, setSort] = useState<'workflow' | 'updated' | 'due'>('workflow')
  const [showArchived, setShowArchived] = useState(false)
  const [newType, setNewType] = useState<ProjectWorkItemType>('user_story')
  const [newTitle, setNewTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const participants = useParticipants(s => s.byId)
  const members = conversation.members.map(id => participants[id]).filter(Boolean)
  const currentConversation = () => useConversations.getState().list.find(c => c.id === conversation.id)
  const isCurrent = () => useAuth.getState().contextEpoch === epoch.current && currentConversation()?.projectId === conversation.projectId

  useEffect(() => {
    dialog.current?.showModal()
    return () => dialog.current?.close()
  }, [])

  const reload = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    try {
      const next = await api.getProjectWorkflow(conversation.id)
      if (!isCurrent() || request !== sequence.current) return
      setContext(next)
      if (!next.workflow) { setItems([]); setSelectedId(null); return }
      const list = await api.listProjectWorkItems(conversation.id, {
        archived: showArchived, search: search || undefined,
        type: typeFilter === 'all' ? undefined : [typeFilter],
        status: statusFilter === 'all' ? undefined : [statusFilter],
        priority: priorityFilter === 'all' ? undefined : [priorityFilter],
        assigneeId: assigneeFilter === 'all' ? undefined : assigneeFilter,
        label: labelFilter || undefined,
      })
      if (!isCurrent() || request !== sequence.current || list.projectId !== conversation.projectId) return
      setItems(list.items)
      setSelectedId(current => current && list.items.some(item => item.id === current) ? current : null)
      setError('')
    } catch (cause) {
      if (isCurrent() && request === sequence.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (isCurrent() && request === sequence.current) setLoading(false) }
  }, [conversation.id, conversation.projectId, showArchived, search, typeFilter, statusFilter, priorityFilter, assigneeFilter, labelFilter])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const off = ws.on(event => {
      if (event.type === 'conversation.updated' && event.conversationId === conversation.id && event.patch.projectId !== undefined) onClose()
      if (event.type === 'conversation.dissolved' && event.conversationId === conversation.id) onClose()
      if (event.type === 'workspace.member_removed') onClose()
      if (event.type === 'project.workflow_changed' && event.conversationId === conversation.id && event.projectId === conversation.projectId) void reload()
    })
    return off
  }, [conversation.id, conversation.projectId, reload, onClose])

  async function act(work: () => Promise<void>, reloadAfter = true) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setError(t('projectWorkflow.conflict'))
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) { setBusy(false); if (reloadAfter) await reload() }
    }
  }

  async function quickCreate(parentId?: string) {
    const title = parentId ? window.prompt(t('projectWorkflow.subtaskTitle'))?.trim() : newTitle.trim()
    if (!title) return
    await api.createProjectWorkItem(conversation.id, { type: parentId ? 'subtask' : newType, title, parentId })
    if (!parentId) setNewTitle('')
  }

  async function move(item: ApiProjectWorkItem, status: ProjectWorkItemStatus) {
    if (item.status === status || busy || context?.workflow?.status === 'closed') return
    const before = items
    setItems(rows => rows.map(row => row.id === item.id ? { ...row, status } : row))
    try {
      const updated = await api.updateProjectWorkItem(conversation.id, item.id, { expectedVersion: item.version, status })
      if (isCurrent()) setItems(rows => rows.map(row => row.id === item.id ? updated : row))
    } catch (cause) {
      if (isCurrent()) { setItems(before); setError(cause instanceof ApiError && cause.status === 409 ? t('projectWorkflow.conflict') : String(cause)) }
    }
  }

  const sortedItems = [...items].sort((left, right) => sort === 'updated'
    ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    : sort === 'due'
      ? (left.dueAt ? Date.parse(left.dueAt) : Number.MAX_SAFE_INTEGER) - (right.dueAt ? Date.parse(right.dueAt) : Number.MAX_SAFE_INTEGER)
      : left.rank - right.rank)
  const selected = items.find(item => item.id === selectedId) ?? null
  const topLevel = sortedItems.filter(item => !item.parentId)
  const children = (parentId: string) => items.filter(item => item.parentId === parentId)

  return <dialog ref={dialog} onCancel={onClose}
    className="h-[min(920px,96vh)] w-[min(1480px,98vw)] rounded-2xl border border-ink-100 p-0 text-ink-900 shadow-2xl backdrop:bg-black/35">
    <section className="flex h-full min-h-0 flex-col bg-sky2-25">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 bg-white px-5 py-4">
        <div>
          <h2 className="text-xl font-semibold">{t('projectWorkflow.title')}</h2>
          <p className="text-sm text-ink-500">{conversation.title} · {conversation.projectName}</p>
        </div>
        <div className="flex items-center gap-2">
          {context?.workflow && <button className={button} onClick={() => setView(view === 'board' ? 'list' : 'board')}>{view === 'board' ? t('projectWorkflow.list') : t('projectWorkflow.board')}</button>}
          {context?.workflow && canManageWorkspace && <button className={button} disabled={busy} onClick={() => void act(() => api.setProjectWorkflowClosed(conversation.id, context.workflow!.status !== 'closed').then(() => undefined))}>
            {context.workflow.status === 'closed' ? t('projectWorkflow.reopen') : t('projectWorkflow.closeWorkflow')}
          </button>}
          <button className={button} onClick={onClose} aria-label={t('projectWorkflow.close')}>×</button>
        </div>
      </header>
      {error && <p role="alert" className="m-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {!loading && context && !context.workflow ? <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="max-w-md rounded-2xl border border-ink-100 bg-white p-8 shadow-sm">
          <div className="mb-3 text-4xl">◇</div>
          <h3 className="text-lg font-semibold">{t('projectWorkflow.notEnabled')}</h3>
          <p className="mt-2 text-sm text-ink-500">{t('projectWorkflow.notEnabledDetail')}</p>
          {context.canManage && <button className={`${primary} mt-5`} disabled={busy} onClick={() => void act(() => api.createProjectWorkflow(conversation.id).then(() => undefined))}>{t('projectWorkflow.enable')}</button>}
        </div>
      </div> : context?.workflow ? <>
        {context.workflow.status === 'closed' && <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-800">{t('projectWorkflow.closedNotice')}</div>}
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 bg-white px-4 py-3">
          <select className={control} value={newType} onChange={e => setNewType(e.target.value as ProjectWorkItemType)} disabled={busy || context.workflow.status === 'closed'}>
            <option value="user_story">{t('projectWorkflow.userStory')}</option><option value="defect">{t('projectWorkflow.defect')}</option>
          </select>
          <input className={`${control} min-w-[220px] flex-1`} value={newTitle} onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void act(() => quickCreate()) }} placeholder={t('projectWorkflow.quickCreate')} disabled={busy || context.workflow.status === 'closed'} />
          <button className={primary} disabled={busy || !newTitle.trim() || context.workflow.status === 'closed'} onClick={() => void act(() => quickCreate())}>{t('projectWorkflow.create')}</button>
          <input className={`${control} w-44`} value={search} onChange={e => setSearch(e.target.value)} placeholder={t('projectWorkflow.search')} />
          <select className={control} value={typeFilter} onChange={e => setTypeFilter(e.target.value as typeof typeFilter)}>
            <option value="all">{t('projectWorkflow.allTypes')}</option><option value="user_story">{t('projectWorkflow.userStory')}</option>
            <option value="defect">{t('projectWorkflow.defect')}</option><option value="subtask">{t('projectWorkflow.subtask')}</option>
          </select>
          <select className={control} value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">{t('projectWorkflow.allStatuses')}</option>{STATUSES.map(status => <option key={status} value={status}>{statusLabel(t, status)}</option>)}
          </select>
          <select className={control} value={priorityFilter} onChange={e => setPriorityFilter(e.target.value as typeof priorityFilter)}>
            <option value="all">{t('projectWorkflow.allPriorities')}</option>{PRIORITIES.map(priority => <option key={priority} value={priority}>{priorityLabel(t, priority)}</option>)}
          </select>
          <select className={control} value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}>
            <option value="all">{t('projectWorkflow.allAssignees')}</option>{members.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className={`${control} w-32`} value={labelFilter} onChange={e => setLabelFilter(e.target.value.trimStart())} placeholder={t('projectWorkflow.labelFilter')} />
          <select className={control} value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
            <option value="workflow">{t('projectWorkflow.sortWorkflow')}</option><option value="updated">{t('projectWorkflow.sortUpdated')}</option><option value="due">{t('projectWorkflow.sortDue')}</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-ink-600"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{t('projectWorkflow.archived')}</label>
        </div>
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-auto p-4">
            {loading ? <p className="p-8 text-center text-ink-500">{t('projectWorkflow.loading')}</p>
            : view === 'board' ? <div className="grid min-w-[1050px] grid-cols-6 gap-3">
              {STATUSES.map(status => <section key={status} className="min-h-[300px] rounded-xl bg-ink-50/70 p-2"
                onDragOver={e => e.preventDefault()} onDrop={e => {
                  const item = items.find(row => row.id === e.dataTransfer.getData('text/work-item-id'))
                  if (item) void move(item, status)
                }}>
                <h3 className="mb-2 flex items-center justify-between px-1 text-xs font-bold uppercase tracking-wide text-ink-500">
                  <span>{statusLabel(t, status)}</span><span>{topLevel.filter(item => item.status === status).length}</span>
                </h3>
                <div className="space-y-2">{topLevel.filter(item => item.status === status).map(item => <WorkItemCard key={item.id} item={item}
                  assignee={item.assigneeId ? participants[item.assigneeId]?.name : undefined} onOpen={() => setSelectedId(item.id)} />)}</div>
              </section>)}
            </div> : <div className="overflow-hidden rounded-xl border border-ink-100 bg-white">
              {items.length === 0 ? <p className="p-8 text-center text-ink-500">{t('projectWorkflow.empty')}</p> : <table className="w-full text-left text-sm">
                <thead className="bg-ink-50 text-xs text-ink-500"><tr><th className="p-3">{t('projectWorkflow.key')}</th><th>{t('projectWorkflow.summary')}</th><th>{t('projectWorkflow.status')}</th><th>{t('projectWorkflow.priority')}</th><th>{t('projectWorkflow.assignee')}</th></tr></thead>
                <tbody>{sortedItems.map(item => <tr key={item.id} className="cursor-pointer border-t border-ink-100 hover:bg-sky2-25" onClick={() => setSelectedId(item.id)}>
                  <td className="p-3 font-mono text-xs">{item.issueKey}</td><td className={item.parentId ? 'pl-6' : ''}>{item.parentId ? '↳ ' : ''}{item.title}</td>
                  <td>{statusLabel(t, item.status)}</td><td>{priorityLabel(t, item.priority)}</td><td>{item.assigneeId ? participants[item.assigneeId]?.name ?? item.assigneeId : '—'}</td>
                </tr>)}</tbody>
              </table>}
            </div>}
          </main>
          {selected && <WorkItemDetail key={`${selected.id}:${selected.version}`} item={selected} subtasks={children(selected.id)}
            conversation={conversation} members={members} canManage={context.canManage} closed={context.workflow.status === 'closed'} busy={busy}
            onClose={() => setSelectedId(null)} onAct={act} onCreatedSubtask={() => quickCreate(selected.id)} onOpenSubtask={setSelectedId}
            onUpdated={item => setItems(rows => rows.map(row => row.id === item.id ? item : row))} />}
        </div>
      </> : <p className="p-8 text-center text-ink-500">{t('projectWorkflow.loading')}</p>}
    </section>
  </dialog>
}

function WorkItemCard({ item, assignee, onOpen }: { item: ApiProjectWorkItem; assignee?: string; onOpen: () => void }) {
  const t = useT()
  return <button type="button" draggable onDragStart={e => e.dataTransfer.setData('text/work-item-id', item.id)} onClick={onOpen}
    className={`w-full rounded-xl border p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow ${statusTone(item.status)}`}>
    <div className="flex items-center justify-between gap-2"><span className="font-mono text-[11px] font-semibold text-ink-500">{item.issueKey}</span><span className="text-[10px] uppercase text-ink-400">{typeLabel(t, item.type)}</span></div>
    <p className="mt-1 line-clamp-3 text-sm font-semibold text-skype-ink">{item.title}</p>
    <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-ink-500"><span>{priorityLabel(t, item.priority)}</span><span className="truncate">{assignee ?? t('projectWorkflow.unassigned')}</span></div>
    {item.subtaskTotal > 0 && <p className="mt-2 text-[11px] text-ink-500">{item.subtaskDone}/{item.subtaskTotal} {t('projectWorkflow.subtasks')}</p>}
  </button>
}

function WorkItemDetail({ item, subtasks, conversation, members, canManage, closed, busy, onClose, onAct, onCreatedSubtask, onOpenSubtask, onUpdated }: {
  item: ApiProjectWorkItem; subtasks: ApiProjectWorkItem[]; conversation: Conversation
  members: Array<{ id: string; name: string; kind: 'human' | 'agent' }>; canManage: boolean; closed: boolean; busy: boolean
  onClose: () => void; onAct: (work: () => Promise<void>, reloadAfter?: boolean) => Promise<void>
  onCreatedSubtask: () => Promise<void>; onOpenSubtask: (itemId: string) => void; onUpdated: (item: ApiProjectWorkItem) => void
}) {
  const t = useT()
  const me = useAuth(s => s.user?.id)
  const [draft, setDraft] = useState(() => itemDraft(item))
  const [comments, setComments] = useState<ApiProjectWorkflowComment[]>([])
  const [activity, setActivity] = useState<ApiProjectWorkflowActivity[]>([])
  const [comment, setComment] = useState('')
  const [tab, setTab] = useState<'details' | 'activity'>('details')
  const assignee = members.find(member => member.id === item.assigneeId)
  useEffect(() => {
    void Promise.all([api.listProjectWorkItemComments(conversation.id, item.id), api.listProjectWorkItemActivity(conversation.id, item.id)])
      .then(([nextComments, nextActivity]) => { setComments(nextComments); setActivity(nextActivity) }).catch(() => {})
  }, [conversation.id, item.id, item.version])

  const save = async () => {
    const payload: Record<string, unknown> & { expectedVersion: number } = {
      expectedVersion: item.version, title: draft.title, description: draft.description, status: draft.status,
      priority: draft.priority, assigneeId: draft.assigneeId || null,
      labels: draft.labels.split(',').map(value => value.trim()).filter(Boolean), dueAt: draft.dueAt || null,
    }
    if (item.type === 'user_story') Object.assign(payload, { userValue: draft.userValue, acceptanceCriteria: draft.acceptanceCriteria,
      storyPoints: draft.storyPoints === '' ? null : Number(draft.storyPoints) })
    if (item.type === 'defect') Object.assign(payload, { severity: draft.severity || null, reproductionSteps: draft.reproductionSteps,
      expectedResult: draft.expectedResult, actualResult: draft.actualResult, environment: draft.environment, resolution: draft.resolution || null })
    try {
      const updated = await api.updateProjectWorkItem(conversation.id, item.id, payload)
      onUpdated(updated)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.data?.code === 'SUBTASKS_INCOMPLETE' && canManage) {
        const forceReason = window.prompt(t('projectWorkflow.forceReason'))?.trim()
        if (forceReason) {
          const updated = await api.updateProjectWorkItem(conversation.id, item.id, { ...payload, forceReason })
          onUpdated(updated)
          return
        }
      }
      if (cause instanceof ApiError && cause.status === 409 && cause.data?.current) {
        onUpdated(cause.data.current as unknown as ApiProjectWorkItem)
      }
      throw cause
    }
  }
  const field = (key: keyof typeof draft, value: string) => setDraft(current => ({ ...current, [key]: value }))

  return <aside className="w-[min(520px,48vw)] shrink-0 overflow-y-auto border-l border-ink-100 bg-white max-md:fixed max-md:inset-2 max-md:z-20 max-md:w-auto max-md:rounded-xl max-md:border max-md:shadow-2xl">
    <header className="sticky top-0 z-10 flex items-start justify-between border-b border-ink-100 bg-white p-4">
      <div><p className="font-mono text-xs text-ink-500">{item.issueKey} · {typeLabel(t, item.type)}</p><h3 className="mt-1 font-semibold">{item.title}</h3></div>
      <button className={button} onClick={onClose}>×</button>
    </header>
    <div className="flex border-b border-ink-100 px-4"><button className={`px-3 py-2 text-sm ${tab === 'details' ? 'border-b-2 border-skype text-skype-deep' : ''}`} onClick={() => setTab('details')}>{t('projectWorkflow.details')}</button><button className={`px-3 py-2 text-sm ${tab === 'activity' ? 'border-b-2 border-skype text-skype-deep' : ''}`} onClick={() => setTab('activity')}>{t('projectWorkflow.activity')}</button></div>
    {tab === 'details' ? <div className="space-y-4 p-4">
      <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.summary')}<input className={`${control} mt-1 w-full`} value={draft.title} onChange={e => field('title', e.target.value)} disabled={closed} /></label>
      <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.description')}<textarea className={`${control} mt-1 min-h-28 w-full`} value={draft.description} onChange={e => field('description', e.target.value)} disabled={closed} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs font-semibold text-ink-500">{t('projectWorkflow.status')}<select className={`${control} mt-1 w-full`} value={draft.status} onChange={e => field('status', e.target.value)} disabled={closed}>{STATUSES.map(status => <option key={status} value={status}>{statusLabel(t, status)}</option>)}</select></label>
        <label className="text-xs font-semibold text-ink-500">{t('projectWorkflow.priority')}<select className={`${control} mt-1 w-full`} value={draft.priority} onChange={e => field('priority', e.target.value)} disabled={closed}>{PRIORITIES.map(priority => <option key={priority} value={priority}>{priorityLabel(t, priority)}</option>)}</select></label>
        <label className="text-xs font-semibold text-ink-500">{t('projectWorkflow.assignee')}<select className={`${control} mt-1 w-full`} value={draft.assigneeId} onChange={e => field('assigneeId', e.target.value)} disabled={closed}><option value="">{t('projectWorkflow.unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}{member.kind === 'agent' ? ' · Agent' : ''}</option>)}</select></label>
        <label className="text-xs font-semibold text-ink-500">{t('projectWorkflow.due')}<input type="date" className={`${control} mt-1 w-full`} value={draft.dueAt} onChange={e => field('dueAt', e.target.value)} disabled={closed} /></label>
      </div>
      <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.labels')}<input className={`${control} mt-1 w-full`} value={draft.labels} onChange={e => field('labels', e.target.value)} placeholder={t('projectWorkflow.labelsHint')} disabled={closed} /></label>
      {item.type === 'user_story' && <div className="space-y-3 rounded-xl bg-sky2-25 p-3">
        <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.userValue')}<textarea className={`${control} mt-1 w-full`} value={draft.userValue} onChange={e => field('userValue', e.target.value)} disabled={closed} /></label>
        <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.acceptanceCriteria')}<textarea className={`${control} mt-1 w-full`} value={draft.acceptanceCriteria} onChange={e => field('acceptanceCriteria', e.target.value)} disabled={closed} /></label>
        <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.storyPoints')}<input type="number" min="0" max="100" className={`${control} mt-1 w-28`} value={draft.storyPoints} onChange={e => field('storyPoints', e.target.value)} disabled={closed} /></label>
      </div>}
      {item.type === 'defect' && <div className="space-y-3 rounded-xl bg-red-50/60 p-3">
        <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.severity')}<select className={`${control} mt-1 w-full`} value={draft.severity} onChange={e => field('severity', e.target.value)} disabled={closed}><option value="">—</option>{PRIORITIES.map(value => <option key={value} value={value}>{priorityLabel(t, value)}</option>)}</select></label>
        {([['reproductionSteps','reproduction'],['expectedResult','expected'],['actualResult','actual'],['environment','environment']] as const).map(([key,label]) => <label key={key} className="block text-xs font-semibold text-ink-500">{t(`projectWorkflow.${label}`)}<textarea className={`${control} mt-1 w-full`} value={draft[key]} onChange={e => field(key, e.target.value)} disabled={closed} /></label>)}
        <label className="block text-xs font-semibold text-ink-500">{t('projectWorkflow.resolution')}<select className={`${control} mt-1 w-full`} value={draft.resolution} onChange={e => field('resolution', e.target.value)} disabled={closed}><option value="">—</option><option value="fixed">fixed</option><option value="duplicate">duplicate</option><option value="cannot_reproduce">cannot reproduce</option><option value="wont_fix">won't fix</option></select></label>
      </div>}
      <button className={primary} disabled={busy || closed || !draft.title.trim()} onClick={() => void onAct(save)}>{t('projectWorkflow.save')}</button>
      {item.assigneeKind === 'agent' && <div className="rounded-xl border border-violet-200 bg-violet-50 p-3">
        <p className="text-sm font-semibold">{t('projectWorkflow.agentNotRunning')}</p><p className="mt-1 text-xs text-ink-500">{t('projectWorkflow.agentNotRunningDetail')}</p>
        <button className={`${primary} mt-3`} disabled={busy || closed} onClick={() => {
          const instruction = window.prompt(t('projectWorkflow.executeInstruction'), '')
          if (instruction !== null) void onAct(() => api.executeProjectWorkItem(conversation.id, item.id, instruction).then(() => undefined))
        }}>{t('projectWorkflow.executeAgent', { name: assignee?.name ?? item.assigneeId ?? 'Agent' })}</button>
      </div>}
      {item.type !== 'subtask' && <section className="rounded-xl border border-ink-100 p-3">
        <div className="flex items-center justify-between"><h4 className="font-semibold">{t('projectWorkflow.subtasks')} · {item.subtaskDone}/{item.subtaskTotal}</h4><button className={button} disabled={closed || busy} onClick={() => void onAct(onCreatedSubtask)}>{t('projectWorkflow.addSubtask')}</button></div>
        <ul className="mt-2 space-y-2">{subtasks.map(subtask => <li key={subtask.id}><button type="button" className="flex w-full items-center justify-between gap-2 rounded-lg bg-ink-50 p-2 text-left text-sm hover:bg-sky2-50" onClick={() => onOpenSubtask(subtask.id)}><span>{subtask.issueKey} · {subtask.title}</span><span className="text-xs text-ink-500">{statusLabel(t, subtask.status)}</span></button></li>)}</ul>
      </section>}
      <WorkItemReferences item={item} conversation={conversation} closed={closed} busy={busy} onAct={onAct} />
      <section className="rounded-xl border border-ink-100 p-3"><h4 className="font-semibold">{t('projectWorkflow.comments')}</h4>
        <div className="mt-2 space-y-2">{comments.map(row => <div key={row.id} className="rounded-lg bg-ink-50 p-2 text-sm"><p className="text-xs text-ink-500">{members.find(member => member.id === row.authorId)?.name ?? row.authorId} · {new Date(row.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap">{row.body}</p>{!row.deletedAt && (row.authorId === me || canManage) && <button className="mt-1 text-xs text-red-600" onClick={() => void onAct(() => api.deleteProjectWorkItemComment(conversation.id, item.id, row.id).then(() => undefined))}>{t('projectWorkflow.delete')}</button>}</div>)}</div>
        <textarea className={`${control} mt-2 w-full`} value={comment} onChange={e => setComment(e.target.value)} placeholder={t('projectWorkflow.commentPlaceholder')} disabled={closed} />
        <button className={`${button} mt-2`} disabled={closed || busy || !comment.trim()} onClick={() => void onAct(async () => { await api.addProjectWorkItemComment(conversation.id, item.id, comment); setComment('') })}>{t('projectWorkflow.addComment')}</button>
      </section>
      <section className="flex flex-wrap gap-2 border-t border-ink-100 pt-4">
        <button className={button} disabled={closed || busy} onClick={() => void onAct(() => api.archiveProjectWorkItem(conversation.id, item.id, item.version, !item.archivedAt).then(() => undefined))}>{item.archivedAt ? t('projectWorkflow.restore') : t('projectWorkflow.archive')}</button>
        {canManage && <button className={`${button} text-red-600`} disabled={closed || busy} onClick={() => { const reason = window.prompt(t('projectWorkflow.deleteReason')); if (reason) void onAct(() => api.deleteProjectWorkItem(conversation.id, item.id, reason).then(onClose)) }}>{t('projectWorkflow.deleteForever')}</button>}
      </section>
    </div> : <div className="space-y-2 p-4">{activity.map(event => <article key={event.id} className="rounded-xl border border-ink-100 p-3 text-sm"><p className="font-semibold">{event.actorName} · {eventLabel(t, event.eventType)}</p><p className="mt-1 text-xs text-ink-500">{new Date(event.createdAt).toLocaleString()}</p>{event.reason && <p className="mt-2 rounded bg-amber-50 p-2">{event.reason}</p>}</article>)}</div>}
  </aside>
}

function WorkItemReferences({ item, conversation, closed, busy, onAct }: {
  item: ApiProjectWorkItem; conversation: Conversation; closed: boolean; busy: boolean
  onAct: (work: () => Promise<void>, reloadAfter?: boolean) => Promise<void>
}) {
  const t = useT()
  const [files, setFiles] = useState<ApiProjectWorkItemFileLink[]>([])
  const [commits, setCommits] = useState<ApiProjectWorkItemCommitLink[]>([])
  const [repositories, setRepositories] = useState<ApiProjectGitRepository[]>([])
  const [listing, setListing] = useState<ProjectFileListing | null>(null)
  const [folderId, setFolderId] = useState('root')
  const [repositoryId, setRepositoryId] = useState('')
  const [commitHash, setCommitHash] = useState('')
  const [commitSummary, setCommitSummary] = useState('')

  const reloadLinks = useCallback(async () => {
    const value = await api.listProjectWorkItemLinks(conversation.id, item.id)
    setFiles(value.files); setCommits(value.commits)
  }, [conversation.id, item.id])

  useEffect(() => {
    setFolderId('root')
    void Promise.all([reloadLinks(), api.listProjectGit(item.projectId)]).then(([, repos]) => {
      setRepositories(repos); setRepositoryId(current => current && repos.some(repo => repo.id === current) ? current : (repos[0]?.id ?? ''))
    }).catch(() => {})
  }, [item.id, item.projectId, reloadLinks])
  useEffect(() => { void projectFilesApi.list(item.projectId, folderId).then(setListing).catch(() => setListing(null)) }, [item.projectId, folderId])

  const run = (work: () => Promise<unknown>) => onAct(async () => { await work(); await reloadLinks() }, false)
  return <section className="rounded-xl border border-ink-100 p-3">
    <h4 className="font-semibold">{t('projectWorkflow.references')}</h4>
    <div className="mt-3 space-y-2">
      {files.map(link => <div key={link.id} className="flex items-center gap-2 rounded-lg bg-ink-50 p-2 text-sm">
        <button className="min-w-0 flex-1 truncate text-left text-skype-deep hover:underline" onClick={() => void onAct(async () => {
          const blob = await projectFilesApi.download({ projectId: item.projectId, entryId: link.entryId, versionId: link.versionId, name: link.name })
          saveDownloadedBlob(blob, link.name)
        }, false)}>📄 {link.name}</button>
        <button className="text-xs text-red-600" disabled={busy || closed} onClick={() => void run(() => api.deleteProjectWorkItemFileLink(conversation.id, item.id, link.id))}>{t('projectWorkflow.removeReference')}</button>
      </div>)}
      {commits.map(link => <div key={link.id} className="flex items-start gap-2 rounded-lg bg-ink-50 p-2 text-sm">
        <div className="min-w-0 flex-1"><p className="font-mono text-xs">{link.repositoryName} · {link.commitHash.slice(0, 12)}</p>{link.summary && <p className="mt-1 text-xs text-ink-500">{link.summary}</p>}</div>
        <button className="text-xs text-red-600" disabled={busy || closed} onClick={() => void run(() => api.deleteProjectWorkItemCommitLink(conversation.id, item.id, link.id))}>{t('projectWorkflow.removeReference')}</button>
      </div>)}
      {files.length === 0 && commits.length === 0 && <p className="text-sm text-ink-500">{t('projectWorkflow.noReferences')}</p>}
    </div>
    {!closed && <details className="mt-3 rounded-lg bg-sky2-25 p-2">
      <summary className="cursor-pointer text-sm font-semibold">{t('projectWorkflow.linkProjectFile')}</summary>
      <nav className="mt-2 flex flex-wrap gap-1 text-xs">
        <button className={button} onClick={() => setFolderId('root')}>/</button>
        {listing?.ancestors.map(folder => <button key={folder.id} className={button} onClick={() => setFolderId(folder.id)}>{folder.name}</button>)}
      </nav>
      <div className="mt-2 max-h-40 space-y-1 overflow-auto">{listing?.entries.map(entry => <div key={entry.id} className="flex items-center justify-between gap-2 rounded bg-white p-2 text-sm">
        <button className="min-w-0 flex-1 truncate text-left" onClick={() => { if (entry.kind === 'directory') setFolderId(entry.id) }}>{entry.kind === 'directory' ? '📁' : '📄'} {entry.name}</button>
        {entry.kind === 'file' && entry.versionId && <button className={button} disabled={busy} onClick={() => void run(() => api.addProjectWorkItemFileLink(conversation.id, item.id, { entryId: entry.id, versionId: entry.versionId!, name: entry.name }))}>{t('projectWorkflow.link')}</button>}
      </div>)}</div>
    </details>}
    {!closed && repositories.length > 0 && <details className="mt-2 rounded-lg bg-sky2-25 p-2">
      <summary className="cursor-pointer text-sm font-semibold">{t('projectWorkflow.linkCommit')}</summary>
      <div className="mt-2 grid gap-2">
        <select className={control} value={repositoryId} onChange={e => setRepositoryId(e.target.value)}>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select>
        <input className={control} value={commitHash} onChange={e => setCommitHash(e.target.value)} placeholder={t('projectWorkflow.commitHash')} />
        <input className={control} value={commitSummary} onChange={e => setCommitSummary(e.target.value)} placeholder={t('projectWorkflow.commitSummary')} />
        <button className={button} disabled={busy || !repositoryId || !/^[0-9a-f]{40,64}$/i.test(commitHash.trim())} onClick={() => void run(async () => {
          await api.addProjectWorkItemCommitLink(conversation.id, item.id, { repositoryId, commitHash: commitHash.trim(), summary: commitSummary.trim() })
          setCommitHash(''); setCommitSummary('')
        })}>{t('projectWorkflow.link')}</button>
      </div>
    </details>}
  </section>
}

type T = ReturnType<typeof useT>
function statusLabel(t: T, value: ProjectWorkItemStatus): string {
  return value === 'todo' ? t('projectWorkflow.todo') : value === 'in_progress' ? t('projectWorkflow.inProgress')
    : value === 'blocked' ? t('projectWorkflow.blocked') : value === 'in_review' ? t('projectWorkflow.inReview')
      : value === 'done' ? t('projectWorkflow.done') : t('projectWorkflow.canceled')
}
function priorityLabel(t: T, value: ProjectWorkItemPriority): string {
  return value === 'low' ? t('projectWorkflow.low') : value === 'medium' ? t('projectWorkflow.medium')
    : value === 'high' ? t('projectWorkflow.high') : t('projectWorkflow.critical')
}
function typeLabel(t: T, value: ProjectWorkItemType): string {
  return value === 'user_story' ? t('projectWorkflow.userStory') : value === 'defect' ? t('projectWorkflow.defect') : t('projectWorkflow.subtask')
}
function eventLabel(t: T, value: string): string {
  if (value === 'item.created') return t('projectWorkflow.eventCreated')
  if (value === 'item.assigned') return t('projectWorkflow.eventAssigned')
  if (value === 'item.status_changed') return t('projectWorkflow.eventStatus')
  if (value === 'item.force_completed') return t('projectWorkflow.eventForced')
  if (value === 'comment.created') return t('projectWorkflow.eventCommented')
  if (value === 'agent.execution_requested') return t('projectWorkflow.eventExecuted')
  return t('projectWorkflow.eventUpdated')
}
