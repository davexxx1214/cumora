/** Host-only process launch boundary. Never import server/DB code here: the
 * computer daemon is a standalone program. Task configuration travels on fd 3
 * and is closed before any model-controlled program starts. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn as nativeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { Writable } from 'node:stream'
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, isAbsolute, resolve, posix } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, realpathSync } from 'node:fs'

export interface TaskSandbox {
  binary: string; enter: string; home: string; server: string
  project?: string; token?: string; allowedPorts?: number[]; runtimeDirs?: string[]
  onSpawn?: (child: ChildProcess) => Promise<void> | void
}
const active = new AsyncLocalStorage<TaskSandbox>()
export const withTaskSandbox = <T>(sandbox: TaskSandbox, work: () => T): T => active.run(sandbox, work)
export const controlledTasksEnabled = () => process.env.CUMORA_PROJECT_TASKS_ENABLED === '1'

/** A reviewed installation may live under an operator home, but never expose
 * that home, a credential subtree, task state, or the backing object store. */
export function assertRuntimeDirectory(dir: string, operatorHomes: string[], privatePaths: string[]): void {
  const contains = (parent: string, child: string) => parent === child || child.startsWith(`${parent}/`)
  const broad = ['/', '/home', '/root', '/tmp', '/var', '/var/tmp', '/opt', '/run', '/etc']
  const forbidden = ['/proc', '/sys', '/dev', '/workspace', '/projects', ...privatePaths,
    ...operatorHomes.flatMap(home => ['.cumora', '.ssh', '.codex', '.claude', '.grok/auth.json', '.grok/config.toml'].map(name => posix.join(home, name)))]
  if (!posix.isAbsolute(dir) || posix.resolve(dir) !== dir || broad.includes(dir) ||
      operatorHomes.some(home => contains(dir, home)) ||
      forbidden.some(path => contains(dir, path) || contains(path, dir))) {
    throw new Error('Runtime directories must name specific trusted engine installations, outside credentials and project data.')
  }
}

// Credentials for model providers are deliberately separate from Cumora's
// daemon credential. Do not pass process.env wholesale across this boundary.
const ENGINE_ENV = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL', 'CURSOR_API_KEY', 'MAX_THINKING_TOKENS', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CUMORA_AGENT_RUNTIME_URL', 'CUMORA_AGENT_RUNTIME_TOKEN', 'CUMORA_AGENT_ID',
  'CUMORA_PROJECT_ID', 'CUMORA_PROJECT_PATH', 'CUMORA_CONVERSATION_ID',
  'TERM', 'LANG', 'LC_ALL', 'TZ', 'NO_COLOR',
])
export function taskEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of ENGINE_ENV) if (source[key] !== undefined) result[key] = source[key]!
  result.PATH = '/home/agent/bin:/usr/local/bin:/usr/bin:/bin'
  result.CODEX_HOME = '/home/agent/.codex'
  result.CLAUDE_CONFIG_DIR = '/home/agent/.claude'
  result.GROK_HOME = '/home/agent/.grok'
  result.GROK_DISABLE_AUTOUPDATER = '1'
  result.GROK_MEMORY = '0'
  result.GROK_SUBAGENTS = '0'
  for (const vendor of ['CURSOR', 'CLAUDE']) for (const feature of ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']) result[`GROK_${vendor}_${feature}_ENABLED`] = '0'
  if (process.env.CUMORA_PROJECT_PYTHON_LIBS) result.PYTHONPATH = process.env.CUMORA_PROJECT_PYTHON_LIBS
  return result
}

/** All engine spawn sites (including classifiers) use this wrapper. An
 * explicit per-turn AsyncLocal context avoids global cross-agent races. */
export function spawnTaskProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const config = active.getStore()
  if (!config) return nativeSpawn(command, args, options)
  if (process.platform !== 'linux' || options.shell) throw new Error('Controlled tasks require Linux and shell:false.')
  const guestPath = (value: string) => value === config.home ? '/home/agent' : value.startsWith(`${config.home}/`) ? `/home/agent/${value.slice(config.home.length + 1)}` : value
  const stdio = Array.isArray(options.stdio) ? [...options.stdio] : ['pipe', 'pipe', 'pipe']
  if (stdio.length > 3) throw new Error('Unexpected inherited task descriptors.')
  stdio.push('pipe')
  const installed = command.includes('/') ? command : (options.env?.PATH ?? process.env.PATH ?? '').split(':').map(dir => join(dir, command)).find(path => existsSync(path))
  const executable = installed ? realpathSync(installed) : command
  const child = nativeSpawn(config.binary, [guestPath(executable), ...args.map(guestPath)], {
    cwd: config.home, env: { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8' }, stdio: stdio as SpawnOptions['stdio'], shell: false,
  })
  const descriptor = child.stdio[3] as Writable | null
  descriptor?.on('error', () => { /* spawn/close handlers report startup failure */ })
  // Do not release configuration (and start the engine) until its recovery
  // identity is on disk. A daemon crash before this closes fd3 and fails shut.
  Promise.resolve(config.onSpawn?.(child)).then(() => {
    descriptor?.end(JSON.stringify({ ...config, env: taskEnvironment(options.env ?? {}) }))
  }).catch(() => { descriptor?.destroy(); child.kill('SIGTERM') })
  return child
}

export async function sandboxConfig(home: string, server: string, project?: { projectId: string; token: string }): Promise<TaskSandbox> {
  const binary = process.env.CUMORA_PROJECT_TASK_BIN ?? ''
  const enter = process.env.CUMORA_PROJECT_TASK_ENTER ?? ''
  if (process.platform !== 'linux' || !isAbsolute(binary) || !isAbsolute(enter)) throw new Error('Install the Linux project-task and task-enter executables before enabling controlled tasks.')
  await Promise.all([access(binary), access(enter)])
  const url = new URL(server)
  // Phase one never sends host-runner credentials to a remote public endpoint.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Project tasks require the local Cumora API URL.')
  const runtimeDirs = (process.env.CUMORA_PROJECT_RUNTIME_DIRS ?? '').split(':').filter(Boolean)
  const operatorHomes = [homedir(), process.env.CUMORA_PROJECT_AUTH_HOME].filter((value): value is string => !!value)
  const privatePaths = [home, process.env.CUMORA_PROJECT_FILES_ROOT, process.env.CUMORA_PROJECT_GIT_ROOT].filter((value): value is string => !!value)
  for (const dir of runtimeDirs) {
    assertRuntimeDirectory(dir, operatorHomes, privatePaths)
    assertRuntimeDirectory(realpathSync(dir), operatorHomes, privatePaths)
  }
  return { binary, enter, home, server, project: project?.projectId, token: project?.token, runtimeDirs,
    allowedPorts: [Number(url.port || (url.protocol === 'https:' ? 443 : 80))] }
}

export async function freshProjectHome(agentId: string): Promise<string> {
  const root = join(homedir(), '.cumora', 'project-tasks')
  await mkdir(root, { recursive: true, mode: 0o700 })
  return mkdtemp(join(root, `${agentId.replace(/[^A-Za-z0-9_-]/g, '_')}-`))
}

/** Authentication only, never provider home mounts, transcripts, global
 * instructions, MCP servers, hooks, skills, or workspace memory. */
export async function prepareTaskAuth(home: string): Promise<void> {
  const sourceHome = process.env.CUMORA_PROJECT_AUTH_HOME ?? homedir()
  for (const name of ['.codex/auth.json', '.claude/.credentials.json', '.grok/auth.json']) {
    const target = join(home, name)
    if (resolve(target) === resolve(sourceHome, name)) continue
    try {
      await access(target)
    } catch {
      try {
        const content = await readFile(join(sourceHome, name), 'utf8')
        JSON.parse(content)
        await mkdir(join(home, name.split('/')[0]), { recursive: true, mode: 0o700 })
        await writeFile(target, content, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
  }
  // Optional explicit, operator-reviewed model-provider config. Not copied
  // implicitly from ~/.codex/config.toml (which may contain global hooks/MCP).
  const config = process.env.CUMORA_PROJECT_CODEX_CONFIG
  if (config) { await mkdir(join(home, '.codex'), { recursive: true }); await copyFile(config, join(home, '.codex/config.toml')) }
}
