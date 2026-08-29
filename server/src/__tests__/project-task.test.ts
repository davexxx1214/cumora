import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertRuntimeDirectory, taskEnvironment } from '../agents/computer/task-sandbox.js'
import { projectTaskPrompt, selectProjectTaskRows } from '../agents/computer/project-task.js'

test('project task environment excludes host credentials, injection hooks and old homes', () => {
  const safe = taskEnvironment({ HOME: '/operator', PATH: '/private/bin', AGENT_RUNTIME_SECRET: 'secret', CUMORA_PROJECT_HOST_SECRET: 'host',
    DATABASE_URL: 'database', CUMORA_AGENT_RUNTIME_TOKEN_FILE: '/old/token', NODE_OPTIONS: '--require /old/hook', LD_PRELOAD: '/old/library',
    OPENAI_API_KEY: 'model-key', CUMORA_AGENT_RUNTIME_TOKEN: 'limited-lease', CUMORA_PROJECT_ID: 'p-one' })
  assert.equal(safe.OPENAI_API_KEY, 'model-key')
  assert.equal(safe.CUMORA_AGENT_RUNTIME_TOKEN, 'limited-lease')
  for (const key of ['HOME', 'AGENT_RUNTIME_SECRET', 'CUMORA_PROJECT_HOST_SECRET', 'DATABASE_URL', 'CUMORA_AGENT_RUNTIME_TOKEN_FILE', 'NODE_OPTIONS', 'LD_PRELOAD']) assert.equal(safe[key], undefined)
  assert.equal(safe.CODEX_HOME, '/home/agent/.codex')
  assert.equal(safe.GROK_HOME, '/home/agent/.grok')
  assert.equal(safe.GROK_MEMORY, '0')
  assert.equal(safe.GROK_SUBAGENTS, '0')
  assert.equal(safe.GROK_CLAUDE_HOOKS_ENABLED, '0')
  assert.ok(!safe.PATH.includes('/private'))
})

test('runtime mounts reject broad paths and credentials while allowing reviewed installations', () => {
  const homes = ['/home/operator']
  const privatePaths = ['/data/project-files', '/tmp/task-home']
  for (const dir of ['/', '/home', '/home/operator', '/home/operator/.ssh', '/home/operator/.grok', '/home/operator/.codex/bin',
    '/home/operator/.cumora/project-tasks', '/data', '/data/project-files/one', '/tmp/task-home', '/workspace/repo', '/proc/self', '/tmp', '/opt', '/home/operator/bin/..']) {
    assert.throws(() => assertRuntimeDirectory(dir, homes, privatePaths), /trusted engine installations/)
  }
  for (const dir of ['/home/operator/.local/bin', '/home/operator/.grok/downloads', '/opt/cumora/python-documents', '/tmp/isolated-test/python-documents']) {
    assert.doesNotThrow(() => assertRuntimeDirectory(dir, homes, privatePaths))
  }
})

test('project task inbox selects exactly one group without acknowledging other groups', () => {
  const rows = [{ id: 1, conversation_id: 'a', project: 'p-a' }, { id: 2, conversation_id: 'b', project: 'p-b' }, { id: 3, conversation_id: 'a', project: 'p-a' }]
  assert.deepEqual(selectProjectTaskRows(rows, 'b').map(r => r.id), [2])
  assert.deepEqual(selectProjectTaskRows(rows, 'gone').map(r => r.id), [1, 3])
  assert.deepEqual(rows.map(r => r.id), [1, 2, 3])
  assert.deepEqual(selectProjectTaskRows([]), [])
})

test('project task prompt specifies one stable path and no automatic file context', () => {
  const prompt = projectTaskPrompt({ conversationId: 'g-one', projectId: 'p-one', digest: 'Please read report.docx' })
  assert.ok(prompt.includes('/projects/p-one'))
  assert.ok(prompt.includes('NOT standing context'))
  assert.ok(prompt.includes('Do not scan this directory'))
  assert.ok(prompt.includes('global memory'))
  assert.ok(prompt.includes('fresh task before intentionally editing that newer version'))
  assert.ok(prompt.includes('Please read report.docx'))
})
