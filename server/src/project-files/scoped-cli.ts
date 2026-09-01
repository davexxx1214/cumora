import { runCli } from '../agents/cli.js'
import { parseArgs } from '../agents/cli-parse.js'
import { buildRuntimeArgv } from '../agents/runtime/cli-argv.js'
import { pool } from '../db/pool.js'
import { commitProjectGit, listAgentProjectGit, projectGitStatus, switchProjectGitBranch } from '../project-git/service.js'
import { fail } from './model.js'
import { shareAgentProjectFile } from './references.js'
import { projectLeaseScope } from './service.js'
import {
  addAgentWorkflowComment, linkAgentWorkflowCommit, listAgentWorkflowItems,
  showAgentWorkflowItem, updateAgentWorkflowStatus,
} from '../project-workflow/agent-service.js'

/** Exact command/flag allowlist; never forward arbitrary CLI commands with a
 * daemon JWT. In particular workspace/memory/search/inbox and generic attach
 * URLs must not cross project-task boundaries. */
export function scopedProjectArgv(argv: unknown, conversationId: string): string[] {
  if (!Array.isArray(argv) || argv.length > 80 || !argv.every(a => typeof a === 'string') || argv.join('').length > 60_000) fail('INVALID_COMMAND', 400, 'Expected bounded argv strings.')
  const [command, ...rest] = argv as string[]
  const parsed = parseArgs(rest)
  const flags: Record<string, string[]> = {
    messages: ['tail', 'json', 'thread'], thread: ['tail', 'json'], glance: ['json'],
    reply: ['quote', 'q', 'continue', 'also'], ack: [],
  }
  if (!flags[command] || Object.keys(parsed.flags).some(f => !flags[command].includes(f))) fail('COMMAND_DENIED', 403, 'This task supports messages, thread, glance, reply, ack and project-file only. Global memory, other groups and generic attachments are unavailable.')
  if (command !== 'thread' && parsed.positional[0] !== conversationId) fail('WRONG_CONVERSATION', 403, 'This task can act only in its assigned conversation.')
  if (command !== 'reply' && parsed.positional.length !== 1) fail('INVALID_COMMAND', 400, 'One target is required.')
  return argv as string[]
}

export async function runProjectCli(token: string, argv: unknown) {
  const lease = await projectLeaseScope(token)
  if (Array.isArray(argv) && argv[0] === 'workflow') {
    if (argv.length > 7 || !argv.every(value => typeof value === 'string') || argv.join('').length > 30_000) fail('INVALID_COMMAND', 400, 'Invalid workflow command.')
    const scope = { projectId: lease.project_id, conversationId: lease.conversation_id, runId: lease.run_id }
    const action = argv[1]
    let value: unknown
    if (action === 'list' && argv.length === 2) value = await listAgentWorkflowItems(lease.agent_id, scope)
    else if (action === 'show' && argv.length === 3) value = await showAgentWorkflowItem(lease.agent_id, argv[2], scope)
    else if (action === 'comment' && argv.length === 4) value = await addAgentWorkflowComment(lease.agent_id, argv[2], argv[3], scope)
    else if (action === 'status' && argv.length === 4) value = await updateAgentWorkflowStatus(lease.agent_id, argv[2], argv[3], scope)
    else if (action === 'link-commit' && (argv.length === 5 || argv.length === 6)) {
      value = await linkAgentWorkflowCommit(lease.agent_id, argv[2], argv[3], argv[4], argv[5] ?? '', scope)
    } else fail('INVALID_COMMAND', 400, 'Use workflow list, show <item>, comment <item> <body>, status <item> <in_progress|blocked|in_review>, or link-commit <item> <repositoryId> <fullHash> [summary].')
    // A lease revoked while the command was running must not return a useful
    // result after project switch/removal.
    await projectLeaseScope(token)
    return { ok: true, exitCode: 0, value, text: JSON.stringify(value, null, 2) }
  }
  if (Array.isArray(argv) && argv[0] === 'project-git') {
    if (argv.length > 5 || !argv.every(value => typeof value === 'string') || argv.join('').length > 10_000) fail('INVALID_COMMAND', 400, 'Invalid project-git command.')
    const action = argv[1]
    if (action === 'list' && argv.length === 2) return { ok: true, exitCode: 0, repositories: await listAgentProjectGit(token) }
    if (action === 'status' && argv.length === 3) return { ok: true, exitCode: 0, ...(await projectGitStatus(token, argv[2])) }
    if (action === 'switch' && argv.length === 4) return { ok: true, exitCode: 0, ...(await switchProjectGitBranch(token, argv[2], argv[3])) }
    if (action === 'commit' && argv.length === 4) return { ok: true, exitCode: 0, ...(await commitProjectGit(token, argv[2], argv[3])) }
    fail('INVALID_COMMAND', 400, 'Use project-git list, status <repositoryId>, switch <repositoryId> <branch>, or commit <repositoryId> <message>.')
  }
  if (Array.isArray(argv) && argv[0] === 'project-file') {
    if (argv.length < 2 || argv.length > 3 || !argv.every(a => typeof a === 'string') || argv.join('').length > 21_000) fail('INVALID_COMMAND', 400, 'project-file <path> [message]')
    return shareAgentProjectFile(token, argv[1], argv[2] ?? '')
  }
  if (Array.isArray(argv) && (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help')) return {
    ok: true, exitCode: 0, text: `Current group: ${lease.conversation_id}\nProject path: /projects/${lease.project_id}\nCommands: messages <group> [--tail N], thread <message>, glance <group>, reply <group> <text> [--quote id], ack <group>, project-file <path> [text], project-git list|status|switch|commit, workflow list|show|comment|status|link-commit.\nWorkflow writes require a human-authorized command created by assignment or a later manual instruction. Agents can set only in_progress, blocked, or in_review; humans complete/cancel. Git tokens are server-side and unavailable to tasks. Read project files only when the user names a file or authorizes the task scope. Do not scan project files, import project instructions, or save their content to global memory.`,
  }
  const safe = scopedProjectArgv(argv, lease.conversation_id)
  const parsed = parseArgs(safe.slice(1))
  const messageId = safe[0] === 'thread' ? parsed.positional[0] : parsed.flags.thread ?? parsed.flags.quote ?? parsed.flags.q
  if (messageId !== undefined) {
    const { rows } = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [String(messageId), lease.conversation_id])
    if (!rows[0]) fail('NOT_FOUND', 404, 'Message not found in this group.')
  }
  const result = await runCli(buildRuntimeArgv(lease.agent_id, safe))
  // A read started just before removal must not deliver its result afterward.
  await projectLeaseScope(token)
  return result
}
