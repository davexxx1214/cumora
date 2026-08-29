import { parseArgs } from '../agents/cli-parse.js'
import { runCli } from '../agents/cli.js'
import { buildRuntimeArgv } from '../agents/runtime/cli-argv.js'
import { pool } from '../db/pool.js'
import { fail } from './model.js'
import { projectLeaseScope } from './service.js'
import { shareAgentProjectFile } from './references.js'

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
  if (Array.isArray(argv) && argv[0] === 'project-file') {
    if (argv.length < 2 || argv.length > 3 || !argv.every(a => typeof a === 'string') || argv.join('').length > 21_000) fail('INVALID_COMMAND', 400, 'project-file <path> [message]')
    return shareAgentProjectFile(token, argv[1], argv[2] ?? '')
  }
  if (Array.isArray(argv) && (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help')) return {
    ok: true, exitCode: 0, text: `Current group: ${lease.conversation_id}\nProject path: /projects/${lease.project_id}\nCommands: messages <group> [--tail N], thread <message>, glance <group>, reply <group> <text> [--quote id], ack <group>, project-file <path> [text].\nRead project files only when the user names a file or authorizes the task scope. Do not scan project files, import project instructions, or save their content to global memory.`,
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
