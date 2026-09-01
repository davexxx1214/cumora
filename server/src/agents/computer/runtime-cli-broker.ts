/** Secure file-IPC bridge between sandboxed BYOA engines and the daemon. */
import { randomUUID } from 'node:crypto'
import { constants as FS_CONSTANTS, watch, type FSWatcher } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
export const CUMORA_SHIM = `#!/usr/bin/env node
'use strict'
;(async () => {
  var ipc = process.env.CUMORA_AGENT_IPC_DIR
  if (!ipc) { console.error('cumora: runtime IPC not set'); process.exit(70) }
  var argv = process.argv.slice(2)
  // Shell-safe body input. A reply written inline (cumora reply id "..text..")
  // is mangled by bash BEFORE this shim runs: backticks and $(...) get run as
  // commands and collapse to empty, quotes get eaten. So --file <path> /
  // --stdin let the body come from a file (written by the editor, no shell) or
  // a pipe; we read it LOCALLY and pass it as one argument that travels as
  // JSON and is never re-parsed by a shell, so code/quotes/$ survive verbatim.
  //
  // It goes LAST, behind a POSIX \`--\`, so the server takes it literally. Spliced
  // in place it was still read as argv: a body starting with \`---\` (markdown
  // rule, front-matter fence, diff header) parsed as a FLAG and the message was
  // silently dropped, and escapes inside it were expanded a second time.
  var fs = require('fs')
  var path = require('path')
  var crypto = require('crypto')
  var body = null
  var fi = argv.indexOf('--file')
  if (fi >= 0 && argv[fi + 1] !== undefined) {
    try { body = fs.readFileSync(argv[fi + 1], 'utf8') }
    catch (e) { console.error('cumora: cannot read --file ' + argv[fi + 1]); process.exit(70) }
    argv.splice(fi, 2)
  }
  var si = argv.indexOf('--stdin')
  if (si >= 0) {
    argv.splice(si, 1)
    if (body === null) { try { body = fs.readFileSync(0, 'utf8') } catch (e) { body = '' } }
  }
  if (body !== null) argv.push('--', body)
  var id = crypto.randomUUID()
  var requests = path.join(ipc, 'requests')
  var responses = path.join(ipc, 'responses')
  var request = path.join(requests, id + '.json')
  var staged = request + '.' + process.pid + '.tmp'
  fs.writeFileSync(staged, JSON.stringify({ argv: argv }), { mode: 0o600 })
  fs.renameSync(staged, request)

  var response = path.join(responses, id + '.json')
  var deadline = Date.now() + 5 * 60 * 1000
  while (!fs.existsSync(response)) {
    if (Date.now() >= deadline) {
      try { fs.unlinkSync(request) } catch (e) {}
      console.error('cumora: daemon IPC timed out')
      process.exit(70)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  var data
  try { data = JSON.parse(fs.readFileSync(response, 'utf8')) }
  finally { try { fs.unlinkSync(response) } catch (e) {} }
  if (data && typeof data.error === 'string' && data.error) console.error('cumora: ' + data.error)
  const code = typeof data.exitCode === 'number' ? data.exitCode : 0
  // Exit from the write CALLBACK, not the next statement: stdout on a PIPE is
  // ASYNC, so process.exit() kills us with the tail still buffered. The engine
  // always runs this shim with stdout piped, so a big result (cumora messages
  // --tail 30, cumora inbox --json) silently arrived truncated at the pipe
  // buffer — 64KB, or 8KB on the socketpair a stdio:'pipe' parent hands us —
  // with exit 0 and empty stderr, so nothing signalled the loss and --json
  // output simply failed to parse. Exiting IN the callback also keeps a reader
  // that closed early (| head) an exit-0 like before, instead of the unhandled
  // EPIPE crash a bare process.exitCode would produce.
  if (typeof data.text === 'string' && data.text) process.stdout.write(data.text + '\\n', () => process.exit(code))
  else process.exit(code)
})().catch((e) => { console.error('cumora:', (e && e.message) || e); process.exit(70) })
`

/** Restricted Claude does not receive Bash at all. This fixed MCP bridge gives
 * it one structured tool that invokes the unprivileged file-IPC shim without
 * a shell. Local-body flags are rejected because the MCP process itself is not
 * inside Claude's Bash sandbox; callers pass body text as an argv item instead. */
export const CUMORA_MCP_SHIM = `#!/usr/bin/env node
'use strict'
var cp = require('child_process')
var path = require('path')
var readline = require('readline')
var shim = path.join(__dirname, 'cumora')
var childEnv = {}
;['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TERM', 'NO_COLOR', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'CUMORA_AGENT_IPC_DIR', 'CUMORA_AGENT_ID'].forEach(function (name) {
  if (process.env[name] !== undefined) childEnv[name] = process.env[name]
})
function send(id, result, error) {
  var msg = { jsonrpc: '2.0', id: id }
  if (error) msg.error = { code: -32602, message: error }
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + '\\n')
}
function toolError(text) {
  return { content: [{ type: 'text', text: text }], isError: true }
}
function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return
  if (msg.method === 'initialize' && msg.id !== undefined) {
    send(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cumora', version: '1.0.0' },
    })
    return
  }
  if (msg.method === 'tools/list' && msg.id !== undefined) {
    send(msg.id, { tools: [{
      name: 'cli',
      description: 'Act in Cumora. Pass command-line words as argv; put message bodies directly in argv and never use local file paths.',
      inputSchema: {
        type: 'object',
        properties: { argv: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2000 } },
        required: ['argv'],
        additionalProperties: false,
      },
    }] })
    return
  }
  if (msg.method === 'tools/call' && msg.id !== undefined) {
    var p = msg.params || {}
    var argv = p.arguments && p.arguments.argv
    if (p.name !== 'cli' || !Array.isArray(argv) || !argv.length || argv.length > 2000 || argv.some(function (v) { return typeof v !== 'string' })) {
      send(msg.id, toolError('invalid Cumora argv'))
      return
    }
    if (argv.some(function (v) { return v === '--file' || v === '--stdin' })) {
      send(msg.id, toolError('local file/stdin flags are unavailable; pass body text directly in argv'))
      return
    }
    cp.execFile(process.execPath, [shim].concat(argv), {
      env: childEnv,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, function (err, stdout, stderr) {
      var text = String(stdout || '')
      if (stderr) text += (text ? '\\n' : '') + String(stderr)
      var failed = !!err
      send(msg.id, { content: [{ type: 'text', text: text.trimEnd() }], isError: failed })
    })
    return
  }
  if (msg.method === 'ping' && msg.id !== undefined) send(msg.id, {})
}
var rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', function (line) {
  try { handle(JSON.parse(line)) }
  catch (e) { process.stderr.write('cumora-mcp: invalid JSON\\n') }
})
`

const CLI_IPC_FALLBACK_POLL_MS = 1_000
const CLI_IPC_MAX_REQUEST_BYTES = 32 * 1024 * 1024
const CLI_IPC_MAX_ARGS = 2_000

export interface RuntimeCliBrokerResult {
  text?: string
  exitCode: number
  error?: string
}

/** File-rendezvous broker used by one AgentRunner.
 *
 * Request names come from readdir(), not request content, and are claimed by an
 * atomic rename before parsing. A malformed/oversized request gets a bounded
 * error response; it can never turn into a path chosen by the model. */
export class RuntimeCliBroker {
  private timer: ReturnType<typeof setInterval> | null = null
  private watcher: FSWatcher | null = null
  private pollPromise: Promise<void> | null = null
  private rerunRequested = false
  private stopped = false
  private abortController = new AbortController()
  private readonly requestsDir: string
  private readonly responsesDir: string

  constructor(
    ipcDir: string,
    private readonly processingDir: string,
    private readonly invoke: (argv: string[], signal: AbortSignal) => Promise<RuntimeCliBrokerResult>,
  ) {
    this.requestsDir = join(ipcDir, 'requests')
    this.responsesDir = join(ipcDir, 'responses')
  }

  async start(): Promise<void> {
    // A stopped broker may be started again by a supervisor. Never clean or
    // reuse its namespace while the previous drain is still unwinding.
    if (this.pollPromise) await this.pollPromise.catch(() => {})
    this.pollPromise = null
    this.rerunRequested = false
    await mkdir(this.requestsDir, { recursive: true })
    await mkdir(this.responsesDir, { recursive: true })
    await mkdir(this.processingDir, { recursive: true })
    // Requests/responses cannot survive their daemon process: the bearer token
    // and server result they belonged to are gone. Remove only this dedicated
    // IPC namespace, never agent work files.
    await this.clearDir(this.requestsDir)
    await this.clearDir(this.responsesDir)
    await this.clearDir(this.processingDir)
    this.stopped = false
    this.abortController = new AbortController()
    // Directory notifications keep the common path event-driven even when one
    // computer hosts many agents. A slow fallback poll covers dropped watcher
    // events and filesystems where fs.watch is unavailable or unreliable.
    try {
      this.watcher = watch(this.requestsDir, { persistent: false }, () => {
        void this.poll().catch((err) => this.logPollFailure(err))
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch { this.watcher = null }
    this.timer = setInterval(() => {
      void this.poll().catch((err) => this.logPollFailure(err))
    }, CLI_IPC_FALLBACK_POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    this.rerunRequested = false
    this.abortController.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }

  /** Immediate poll for deterministic tests; the normal runner uses the timer. */
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    // Coalesce an arbitrary watcher/timer storm into one pending rerun. Every
    // caller shares the same drain promise, so an explicit await still covers a
    // request that landed after the active pass took its readdir snapshot.
    this.rerunRequested = true
    if (!this.pollPromise) {
      const drain = this.drainPolls()
      this.pollPromise = drain
      // Use both handlers instead of .finally(): ignoring the Promise returned
      // by finally() would itself create an unhandled rejection on failure.
      void drain.then(
        () => { if (this.pollPromise === drain) this.pollPromise = null },
        () => { if (this.pollPromise === drain) this.pollPromise = null },
      )
    }
    return this.pollPromise
  }

  private async drainPolls(): Promise<void> {
    while (!this.stopped && this.rerunRequested) {
      this.rerunRequested = false
      const names = await readdir(this.requestsDir).catch(() => [] as string[])
      for (const name of names) {
        if (this.stopped || this.abortController.signal.aborted) break
        if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue
        try { await this.handle(name) }
        catch (err) { this.logPollFailure(err, name) }
      }
    }
  }

  private logPollFailure(err: unknown, name?: string): void {
    console.error(
      `[runtime] CLI IPC broker${name ? ` request ${name}` : ''} failed`,
      err instanceof Error ? err.message : String(err),
    )
  }

  private async handle(name: string): Promise<void> {
    const signal = this.abortController.signal
    if (signal.aborted) return
    const source = join(this.requestsDir, name)
    // Production puts processingDir outside the model-writable Agent home.
    // Once rename succeeds, the sandbox cannot replace the claimed inode during
    // the lstat/open gap (including on Windows, where O_NOFOLLOW is unavailable).
    const claimed = join(this.processingDir, `${name}.${process.pid}.${randomUUID().slice(0, 8)}.processing`)
    try { await rename(source, claimed) } catch { return }
    const response = join(this.responsesDir, name)
    let stagedResponse: string | null = null
    let result: RuntimeCliBrokerResult
    try {
      // Never follow a model-created request symlink with the daemon's broader
      // privileges. O_NOFOLLOW is defense in depth on POSIX; the private claim
      // directory closes the check/open race on every supported platform.
      const before = await lstat(claimed)
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error('runtime IPC request is not a regular file')
      }
      const noFollow = typeof FS_CONSTANTS.O_NOFOLLOW === 'number' ? FS_CONSTANTS.O_NOFOLLOW : 0
      const file = await open(claimed, FS_CONSTANTS.O_RDONLY | noFollow)
      let raw: string
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > CLI_IPC_MAX_REQUEST_BYTES) {
          throw new Error('runtime IPC request is too large')
        }
        raw = await file.readFile('utf8')
      }
      finally { await file.close() }
      const parsed = JSON.parse(raw) as { argv?: unknown }
      if (!Array.isArray(parsed.argv)
          || parsed.argv.length > CLI_IPC_MAX_ARGS
          || parsed.argv.some((arg) => typeof arg !== 'string')) {
        throw new Error('runtime IPC argv is invalid')
      }
      if (signal.aborted) throw new Error('runtime IPC request cancelled')
      result = await this.invoke(parsed.argv as string[], signal)
    } catch (err) {
      if (signal.aborted) {
        await rm(claimed, { force: true }).catch(() => {})
        return
      }
      result = { exitCode: 70, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      if (signal.aborted) return
      // Stage in the daemon-private directory. The model can write response
      // contents only after the final atomic rename, never redirect a privileged
      // write by pre-creating a symlink at a guessed temporary name.
      stagedResponse = join(this.processingDir, `${name}.${process.pid}.${randomUUID().slice(0, 8)}.response.tmp`)
      await writeFile(stagedResponse, JSON.stringify(result), { mode: 0o600 })
      if (signal.aborted) return
      await rename(stagedResponse, response)
      stagedResponse = null
    } finally {
      if (stagedResponse) await rm(stagedResponse, { force: true }).catch(() => {})
      await rm(claimed, { force: true }).catch(() => {})
    }
  }

  private async clearDir(dir: string): Promise<void> {
    const names = await readdir(dir).catch(() => [] as string[])
    // These directories contain protocol files only. Never recurse into a
    // model-created directory/junction while cleaning stale traffic.
    await Promise.all(names.map((name) => rm(join(dir, name), { force: true }).catch(() => {})))
  }
}

/** PowerShell only resolves files on PATH through PATHEXT, so the extensionless
 *  POSIX shim needs a .cmd launcher on Windows. Keep the Node program itself in
 *  one file so both launchers exercise the exact same argument/HTTP path. */
export const CUMORA_WINDOWS_SHIM = '@echo off\r\nnode "%~dp0cumora" %*\r\n'

export function prependAgentBinToPath(binDir: string, currentPath = process.env.PATH ?? ''): string {
  return currentPath ? `${binDir}${delimiter}${currentPath}` : binDir
}

/** Secure adapters must resolve their own binary from the operator's original
 * PATH. The agent home is model-writable, so prepending <home>/bin would let a
 * model plant `claude`/`codex` and escape before the next sandbox starts. */
export function engineProcessPath(
  binDir: string,
  currentPath = process.env.PATH ?? '',
  unsandboxed = process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED === '1',
): string {
  if (unsandboxed) return prependAgentBinToPath(binDir, currentPath)
  const writableHome = resolve(dirname(binDir))
  return currentPath
    .split(delimiter)
    // Empty and relative PATH entries resolve against the engine cwd — its
    // model-writable home — and are therefore engine-shadow paths too.
    .filter((entry) => {
      if (!entry || !isAbsolute(entry)) return false
      const fromHome = relative(writableHome, resolve(entry))
      return isAbsolute(fromHome) || fromHome === '..' || fromHome.startsWith(`..${sep}`)
    })
    .join(delimiter)
}

async function writeShimFile(path: string, data: string, mode: number): Promise<void> {
  const staged = join(dirname(path), `.cumora-shim-${process.pid}-${randomUUID()}.tmp`)
  await writeFile(staged, data, { encoding: 'utf8', mode, flag: 'wx' })
  try {
    await chmod(staged, mode)
    try { await rename(staged, path) }
    catch (err) {
      if (process.platform !== 'win32'
          || !['EEXIST', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      await rm(path, { force: true })
      await rename(staged, path)
    }
  } finally {
    await rm(staged, { force: true }).catch(() => {})
  }
}

export async function writeShim(
  binDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    const info = await lstat(binDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`secure BYOA refuses linked shim directory: ${binDir}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await mkdir(binDir, { recursive: true })
    const created = await lstat(binDir)
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error(`secure BYOA could not create a trusted shim directory: ${binDir}`)
    }
  }
  await writeShimFile(join(binDir, 'cumora'), CUMORA_SHIM, 0o755)
  await writeShimFile(join(binDir, 'cumora-mcp'), CUMORA_MCP_SHIM, 0o755)
  if (platform === 'win32') {
    await writeShimFile(join(binDir, 'cumora.cmd'), CUMORA_WINDOWS_SHIM, 0o600)
  }
}
