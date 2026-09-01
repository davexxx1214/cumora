import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ALLOW_UNSANDBOXED_BYOA_ENV,
  claudeSecureFlags,
  codexSecureExecArgs,
  noteCodexConfigRejection,
  resetCodexProfileRejection,
  runnableEngineIds,
  secureEngineCapabilityReason,
} from '../agents/computer/engine.js'
import { engineProcessPath, RuntimeCliBroker } from '../agents/computer/runtime-cli-broker.js'

test('secure mode permits only verified sandbox adapters by default', () => {
  assert.deepEqual(runnableEngineIds(['claude', 'codex', 'grok', 'cursor'], {}, 'linux'), ['claude', 'codex'])
  assert.deepEqual(
    runnableEngineIds(['claude', 'codex', 'grok', 'cursor'], { [ALLOW_UNSANDBOXED_BYOA_ENV]: '1' }, 'linux'),
    ['claude', 'codex', 'grok', 'cursor'],
  )
  assert.match(secureEngineCapabilityReason('codex', '0.137.9', 'linux') ?? '', /older than/)
  assert.equal(secureEngineCapabilityReason('codex', '0.138.0', 'linux'), null)
})

test('Codex secure argv is strict, network denied, and keeps dynamic trust keys parseable', () => {
  const args = codexSecureExecArgs({
    home: '/home/agent one',
    env: { PATH: '/usr/bin:/bin', CUMORA_AGENT_ID: 'agent-1', CUMORA_AGENT_IPC_DIR: '/tmp/ipc', CUMORA_AGENT_MCP_SHIM: '/opt/cumora/cumora-mcp' },
  })
  assert.ok(args.includes('--strict-config'))
  assert.ok(args.includes('permissions.cumora.network.enabled=false'))
  assert.ok(args.some((arg) => arg.startsWith('projects={"/home/agent one"=')))
  assert.ok(!args.some((arg) => arg.startsWith('projects."')))
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.deepEqual(args.slice(-5), ['-a', 'never', 'exec', '--ignore-user-config', '--ignore-rules'])
})

test('Claude secure flags expose only the fixed Cumora MCP tool', () => {
  const flags = claudeSecureFlags('/home/agent', {
    PATH: '/usr/bin:/bin',
    CUMORA_AGENT_IPC_DIR: '/tmp/ipc',
    CUMORA_AGENT_MCP_SHIM: '/opt/cumora/cumora-mcp',
    OPENAI_API_KEY: 'must-not-reach-tools',
  })
  assert.ok(flags.includes('--restricted'))
  assert.ok(flags.includes('Read,Write,Edit,Glob,Grep,mcp__cumora__cli'))
  const settings = JSON.parse(flags[flags.indexOf('--settings') + 1] ?? '{}') as { sandbox?: { credentials?: { envVars?: Array<{ name?: string }> } } }
  assert.ok(settings.sandbox?.credentials?.envVars?.some((entry) => entry.name === 'OPENAI_API_KEY'))
})

test('secure PATH removes model-writable engine shadow directories', () => {
  const bin = join(tmpdir(), 'agent-home', 'bin')
  const path = engineProcessPath(bin, [bin, '.', '/usr/bin', '/bin'].join(process.platform === 'win32' ? ';' : ':'), false)
  assert.ok(!path.includes(bin))
  assert.ok(!path.split(process.platform === 'win32' ? ';' : ':').includes('.'))
})

test('Codex config rejection is surfaced once with an explicit compatibility hint', () => {
  resetCodexProfileRejection()
  const logs: string[] = []
  assert.equal(noteCodexConfigRejection('Error loading config.toml: unknown configuration field', (line) => logs.push(line)), true)
  assert.equal(noteCodexConfigRejection('Error loading config.toml: repeated', (line) => logs.push(line)), false)
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /CUMORA_BYOA_ALLOW_UNSANDBOXED=1/)
})

test('runtime CLI broker atomically claims a bounded argv request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-ipc-'))
  try {
    const ipc = join(root, 'ipc')
    const requests = join(ipc, 'requests')
    const responses = join(ipc, 'responses')
    await Promise.all([mkdir(requests, { recursive: true }), mkdir(responses, { recursive: true })])
    const broker = new RuntimeCliBroker(ipc, join(root, 'processing'), async (argv) => ({ exitCode: 0, text: argv.join('|') }))
    await broker.start()
    const name = '00000000-0000-4000-8000-000000000001.json'
    await writeFile(join(requests, name), JSON.stringify({ argv: ['inbox', '--json'] }), 'utf8')
    await broker.poll()
    const response = JSON.parse(await readFile(join(responses, name), 'utf8')) as { exitCode?: number; text?: string }
    assert.deepEqual(response, { exitCode: 0, text: 'inbox|--json' })
    broker.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
