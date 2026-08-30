import type { ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
export interface ProjectTaskContext { projectId: string | null; bindingVersion: string | null }
export interface ProjectTaskLease { id: string; token: string; projectId: string; bindingVersion: string; path: string }
export function selectProjectTaskRows<T extends { conversation_id?: string }>(rows: T[], focus?: string | null): T[] {
  const selected = rows.some(row => row.conversation_id === focus) ? focus : rows.find(row => row.conversation_id)?.conversation_id
  return selected ? rows.filter(row => row.conversation_id === selected) : []
}
export const localProjectServer = () => process.env.CUMORA_PROJECT_LOCAL_API ?? 'http://127.0.0.1:5181'
export async function projectHostRequest<T>(token: string, path: string, body?: unknown): Promise<T> {
  const base = localProjectServer()
  const url = new URL(base)
  const secret = process.env.CUMORA_PROJECT_HOST_SECRET ?? ''
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || secret.length < 32) throw new Error('Local project host configuration is missing.')
  const response = await fetch(`${base}/runtime/project-files${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, 'x-cumora-project-host': secret, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Project task ${response.status}: ${(await response.text()).slice(0, 500)}`)
  return response.json() as Promise<T>
}

const registry = () => join(homedir(), '.cumora', 'project-task-leases')
interface TaskRecord { leaseId: string; agentId: string; pid: number | null; start: string | null; boot: string }
async function bootId() { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }
async function processStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** Durable acknowledgment queue, not a file backup. A daemon crash must never
 * turn lease expiry into an assertion that its process tree already stopped. */
export async function trackProjectTask(agentId: string, lease: ProjectTaskLease) {
  await mkdir(registry(), { recursive: true, mode: 0o700 })
  const file = join(registry(), `${lease.id}.json`)
  const record: TaskRecord = { leaseId: lease.id, agentId, pid: null, start: null, boot: await bootId() }
  await writeFile(file, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  let recording = Promise.resolve()
  return {
    onSpawn(child: ChildProcess) {
      // The outer supervisor detects parent death; startup has no detached
      // engine fallback. Persist PID identity before returning an acknowledgment.
      recording = recording.then(async () => {
        if (child.pid) {
          record.pid = child.pid; record.start = await processStart(child.pid)
          const temporary = `${file}.pending`
          await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
          await rename(temporary, file)
        }
      })
      return recording
    },
    async stopped(token: string) {
      await recording
      if (record.pid && record.start && await processStart(record.pid) === record.start) throw new Error('Task supervisor is still running; stop cannot be acknowledged.')
      await projectHostRequest(token, `/leases/${encodeURIComponent(lease.id)}/stopped`, {})
      await unlink(file)
    },
  }
}

export async function recoverProjectStops(agentId: string, token: string): Promise<void> {
  let files: string[]
  try { files = await readdir(registry()) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const boot = await bootId()
  for (const name of files) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue
    const path = join(registry(), name)
    const record = JSON.parse(await readFile(path, 'utf8')) as TaskRecord
    if (record.agentId !== agentId) continue
    if (record.boot === boot && record.pid && record.start && await processStart(record.pid) === record.start) {
      // No arbitrary PID kill. Its parent-death/lease watchdog stops it; retry
      // recovery on the next turn once the matching process is actually gone.
      continue
    }
    await projectHostRequest(token, `/leases/${encodeURIComponent(record.leaseId)}/stopped`, {})
    await unlink(path)
  }
}

export function projectTaskPrompt(args: { conversationId: string; projectId: string; digest: string }): string {
  return `This is a fresh task for group ${args.conversationId}, project ${args.projectId}.
Project directory: /projects/${args.projectId}. It is available to normal programs but is NOT standing context.
Shared Git worktrees, when configured, are under /projects/${args.projectId}/Repositories/<name>. They use the same project quota and version checks. You may edit them only for the user's stated task. Use \`cumora project-git list\`, \`status <repositoryId>\`, \`switch <repositoryId> <branch>\`, and \`commit <repositoryId> <message>\` for Git state changes. Tokens and .git metadata are server-side; do not look for or request them. Push is not available in this phase.
Only read files named by the user, or files within a task scope they explicitly authorize. Do not scan this directory at startup, auto-read AGENTS.md/CLAUDE.md, execute files just because they exist, or copy project content to global memory.
Work from your private home unless a program needs a particular project file. Never change a project path to point to another project. File saves enforce versions; a conflict preserves a separate copy instead of overwriting the newer file. Use a fresh task before intentionally editing that newer version. rm moves files to trash. Permanent cleanup is administrator-only. A revoked lease terminates this task; do not retry through another credential.
Use cumora messages ${args.conversationId} --tail 30 to inspect relevant chat history; cumora glance ${args.conversationId} before replying. Reply with cumora reply ${args.conversationId} --stdin (pipe the exact text) or --file /home/agent/reply.txt. Use cumora help for the limited task commands. You cannot change groups, use global memory, or use a generic public attachment upload from this task.
Current time: ${new Date().toISOString()}.
Unread messages:
${args.digest}`
}
