import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get as httpGet, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { createProjectLease, projectFilesFor, stopProjectLease } from '../project-files/service.js'
import { LocalProjectObjects } from '../project-files/objects.js'
import { PROJECT_FILE_MAX_BYTES, type ProjectFileState } from '../project-files/model.js'
import { projectMountRouter } from '../project-files/mount-router.js'
import { runtimeRouter } from '../agents/runtime/server.js'
import { signAgentToken } from '../agents/runtime/jwt.js'
import { taskEnvironment, withTaskSandbox, spawnTaskProcess } from '../agents/computer/task-sandbox.js'
import { prepareTaskAuth } from '../agents/computer/task-sandbox.js'
import { getAdapter } from '../agents/computer/engine.js'
import { storage } from '../storage.js'
import { trackProjectTask, recoverProjectStops } from '../agents/computer/project-task.js'

const users = ['owner', 'member', 'outsider'] as const
const servers: Server[] = []
const urls = new Map<string, string>()
let root = ''
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cumora-project-integration-'))
  env.PROJECT_FILES_ENABLED = true; env.PROJECT_FILES_ROOT = root
  await ensureSchemaOnce()
  for (const user of users) {
    const app = await buildApiTestApp(user)
    app.use('/project-fs', projectMountRouter)
    app.use('/runtime', runtimeRouter)
    if (user === 'owner') app.post('/test/revoke-project-lease', async (_req, res) => {
      await pool.query("UPDATE project_file_leases SET revoked_at=NOW() WHERE project_id='p-files'")
      res.json({ ok: true })
    })
    const server = createServer(app).listen(0, '127.0.0.1')
    servers.push(server); await once(server, 'listening')
    const address = server.address()!
    assert.equal(typeof address, 'object')
    urls.set(user, `http://127.0.0.1:${(address as { port: number }).port}`)
  }
})
beforeEach(async () => {
  await resetAllTables()
  await pool.query("INSERT INTO companies(id,name,slug,owner_user_id) VALUES ('co-files','Files','files','owner'),('co-other','Other','other','owner')")
  for (const user of users) await seedUserMembership(user, 'co-files')
  await pool.query("UPDATE company_members SET role='member' WHERE user_id <> 'owner'")
  await pool.query("UPDATE company_members SET role='owner' WHERE user_id='owner'")
  await pool.query("INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES ('agent','co-files','agent','Agent','A','#000','avail')")
  await pool.query("INSERT INTO projects(id,company_id,name) VALUES ('p-files','co-files','Files'),('p-next','co-files','Next'),('p-hidden','co-files','Hidden'),('p-other','co-other','Other')")
  await pool.query(`INSERT INTO conversations(id,kind,title,company_id,members,project_id) VALUES
    ('g-files','group','Files','co-files','["owner","member","agent"]','p-files'),
    ('g-hidden','group','Hidden','co-files','["outsider"]','p-hidden'),
    ('g-empty','group','Empty','co-files','["owner","member"]',NULL)`)
})
after(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
  await teardownAll()
  if (root) await rm(root, { recursive: true, force: true })
})
function request(user: string, path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  return fetch(`${urls.get(user)}/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-company-id': 'co-files', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) })
}
async function binding(project = 'p-files') {
  const result = await request('owner', `/project-files/${project}/entries`)
  assert.equal(result.status, 200, await result.clone().text())
  return (await result.json() as { bindingVersion: string }).bindingVersion
}
async function upload(user = 'member', project = 'p-files') {
  const res = await request(user, `/project-files/${project}/operations`, 'POST', { requestId: randomUUID(), bindingVersion: await binding(project),
    command: { type: 'upload', parentId: 'root', name: `test-${randomUUID()}.txt`, content: Buffer.from('hello').toString('base64') } })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json() as { entry: { id: string; revision: string; versionId: string; name: string } }).entry
}

test('[integration] project files require current group membership, including admins and Range requests', async () => {
  const file = await upload()
  for (const path of [`/project-files/p-files/entries`, `/project-files/p-files/entries/${file.id}`,
    `/project-files/p-files/entries/${file.id}/download?versionId=${file.versionId}`]) {
    assert.equal((await request('outsider', path, 'GET', undefined, { Range: 'bytes=0-1' })).status, 404)
  }
  assert.equal((await request('owner', '/project-files/p-hidden/entries')).status, 404)
  assert.equal((await request('member', '/project-files/p-next/entries')).status, 404)
  assert.equal((await request('owner', '/project-files/p-other/entries')).status, 404)
  const download = await request('member', `/project-files/p-files/entries/${file.id}/download`)
  assert.equal(await download.text(), 'hello')
  assert.equal(download.headers.get('cache-control'), 'private, no-store')
  assert.match(download.headers.get('content-disposition')!, /^attachment;/u)
  await pool.query(`UPDATE conversations SET members='["owner","agent"]' WHERE id='g-files'`)
  assert.equal((await request('member', `/project-files/p-files/entries/${file.id}/download`)).status, 404)
})

test('[integration] the advertised 25MiB file boundary passes the real JSON parser', { timeout: 30_000 }, async () => {
  const result = await request('member', '/project-files/p-files/operations', 'POST', {
    requestId: randomUUID(), bindingVersion: await binding(),
    command: { type: 'upload', parentId: 'root', name: 'boundary.bin', content: Buffer.alloc(PROJECT_FILE_MAX_BYTES).toString('base64') },
  })
  assert.equal(result.status, 200, await result.clone().text())
  const entry = (await result.json() as { entry: { id: string } }).entry
  const download = await request('member', `/project-files/p-files/entries/${entry.id}/download`)
  assert.equal((await download.arrayBuffer()).byteLength, PROJECT_FILE_MAX_BYTES)
})

test('[integration] a download already in progress stops after group membership removal', { timeout: 20_000 }, async () => {
  const service = projectFilesFor({ kind: 'human', id: 'member', companyId: 'co-files' })
  const size = 8 * 1024 * 1024
  const file = (await service.execute('p-files', randomUUID(), { type: 'upload', parentId: 'root', name: 'large.bin', content: Buffer.alloc(size, 7).toString('base64') })).entry!
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    httpGet(`${urls.get('member')}/api/project-files/p-files/entries/${file.id}/download`, { headers: { 'x-company-id': 'co-files' } }, resolve).on('error', reject)
  })
  assert.equal(response.statusCode, 200)
  let received = 0
  response.on('data', chunk => { received += chunk.length })
  response.on('error', () => { /* an interrupted stream is expected */ })
  const closed = new Promise<void>(resolve => response.once('close', resolve))
  response.pause()
  await pool.query(`UPDATE conversations SET members='["owner","agent"]' WHERE id='g-files'`)
  response.resume()
  await closed
  assert.ok(received < size, 'The whole file must not be delivered after access is revoked.')
})

test('[integration] members manage files but cannot create, switch, purge or discover unrelated projects', async () => {
  const file = await upload()
  const projects = await (await request('member', '/projects')).json() as Array<{ id: string }>
  assert.deepEqual(projects.map(p => p.id), ['p-files'])
  assert.equal((await request('member', '/projects', 'POST', { name: 'Forbidden' })).status, 403)
  assert.equal((await request('member', '/conversations/g-files/project', 'POST', { projectId: 'p-next' })).status, 403)
  assert.equal((await request('member', '/conversations', 'POST', { title: 'Bypass', members: ['owner'], projectId: 'p-next' })).status, 403)
  const remove = await request('member', '/project-files/p-files/operations', 'POST', { requestId: randomUUID(), bindingVersion: await binding(),
    command: { type: 'trash', entryId: file.id, expectedRevision: file.revision } })
  assert.equal(remove.status, 200)
  const trash = await (await request('member', '/project-files/p-files/entries?trash=1')).json() as { entries: Array<{ id: string; revision: string }> }
  assert.equal(trash.entries.length, 1)
  const purge = await request('member', '/project-files/p-files/operations', 'POST', { requestId: randomUUID(), bindingVersion: await binding(),
    command: { type: 'purge', entryId: file.id, expectedRevision: trash.entries[0].revision, confirm: true } })
  assert.equal(purge.status, 403)
})

test('[integration] project binding is exclusive, including direct SQL and group creation', async () => {
  assert.equal((await request('owner', '/conversations/g-empty/project', 'POST', { projectId: 'p-files' })).status, 409)
  await assert.rejects(pool.query("UPDATE conversations SET project_id='p-files' WHERE id='g-empty'"), (error: unknown) => (error as { code: string }).code === '23505')
  await pool.query("UPDATE projects SET file_switching=TRUE WHERE id='p-next'")
  await assert.rejects(pool.query("UPDATE conversations SET project_id='p-next' WHERE id='g-empty'"), (error: unknown) => (error as { code: string }).code === '23514')
  await pool.query("UPDATE projects SET file_switching=FALSE WHERE id='p-next'")
  const results = await Promise.all([
    request('owner', '/conversations/g-empty/project', 'POST', { projectId: 'p-next' }),
    request('owner', '/conversations', 'POST', { title: 'Competing group', members: ['member'], projectId: 'p-next' }),
  ])
  assert.equal(results.filter(res => res.ok).length, 1)
  assert.equal((await pool.query("SELECT id FROM conversations WHERE project_id='p-next'")).rowCount, 1)
})

test('[integration] switching revokes leases, waits for task exit and leaves files in their original project', async () => {
  const file = await upload()
  await pool.query("INSERT INTO agent_runs(id,agent_id,company_id) VALUES ('run-file-test','agent','co-files')")
  const version = await binding()
  const lease = await createProjectLease({ agentId: 'agent', companyId: 'co-files', conversationId: 'g-files', runId: 'run-file-test', bindingVersion: version })
  assert.equal((await projectFilesFor({ kind: 'lease', token: lease.token }).read('p-files', file.id)).content.toString(), 'hello')
  const waiting = await request('owner', '/conversations/g-files/project', 'POST', { projectId: 'p-next' })
  assert.equal(waiting.status, 409)
  assert.equal((await waiting.json() as { code: string }).code, 'TASKS_STOPPING')
  assert.equal((await pool.query("SELECT project_id FROM conversations WHERE id='g-files'")).rows[0].project_id, 'p-files')
  await assert.rejects(projectFilesFor({ kind: 'lease', token: lease.token }).read('p-files', file.id))
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-files' })
  assert.equal((await request('owner', '/conversations/g-files/project', 'POST', { projectId: 'p-next' })).status, 200)
  assert.equal((await request('member', `/project-files/p-files/entries/${file.id}/download`)).status, 404)
  assert.equal((await request('owner', `/project-files/p-files/entries/${file.id}/download`)).status, 200)
  const stale = await request('member', '/project-files/p-next/operations', 'POST', { requestId: randomUUID(), bindingVersion: version,
    command: { type: 'mkdir', parentId: 'root', name: 'stale' } })
  assert.equal(stale.status, 409)
})

test('[integration] removing and re-adding an agent never revives the old file lease', async () => {
  await pool.query("INSERT INTO agent_runs(id,agent_id,company_id) VALUES ('run-file-test','agent','co-files')")
  const lease = await createProjectLease({ agentId: 'agent', companyId: 'co-files', conversationId: 'g-files', runId: 'run-file-test', bindingVersion: await binding() })
  await pool.query(`UPDATE conversations SET members='["owner","member"]' WHERE id='g-files'`)
  await pool.query(`UPDATE conversations SET members='["owner","member","agent"]' WHERE id='g-files'`)
  await assert.rejects(projectFilesFor({ kind: 'lease', token: lease.token }).list('p-files'))
})

test('[integration] lost disk objects disappear from the current file list without automatic restoration', async () => {
  const file = await upload()
  const result = await pool.query<{ state: ProjectFileState }>("SELECT state FROM project_file_spaces WHERE project_id='p-files'")
  const version = result.rows[0].state.entries[file.id].versions[0]
  await new LocalProjectObjects(root).remove('p-files', version.objectId)
  const list = await (await request('member', '/project-files/p-files/entries')).json() as { entries: unknown[] }
  assert.equal(list.entries.length, 0)
  assert.equal((await request('member', `/project-files/p-files/entries/${file.id}/download`)).status, 404)
  assert.notEqual((await upload()).id, file.id)
})

test('[integration] real Linux project mount uses the same API, versions, trash and revocation', {
  skip: !process.env.CUMORA_PROJECT_FUSE_TEST_BIN,
  timeout: 120_000,
}, async () => {
  await pool.query("INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES ('agent-two','co-files','agent','Agent Two','B','#000','avail')")
  await pool.query(`UPDATE conversations SET members='["owner","member","agent","agent-two"]' WHERE id='g-files'`)
  const tokens: string[] = []
  for (const agentId of ['agent', 'agent-two']) {
    const runId = randomUUID()
    await pool.query('INSERT INTO agent_runs(id,agent_id,company_id) VALUES ($1,$2,$3)', [runId, agentId, 'co-files'])
    const lease = await createProjectLease({ agentId, companyId: 'co-files', conversationId: 'g-files', runId, bindingVersion: await binding() })
    tokens.push(lease.token)
  }
  const child = spawn('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child', '--mount-proc',
    process.env.CUMORA_PROJECT_FUSE_TEST_BIN!, '-test.v', '-test.run', '^Test(KernelProjectFiles|ClientInterrupt)$', '-test.timeout', '90s'], {
    env: { ...process.env, CUMORA_PROJECT_FS_MOUNT_TEST: '1', CUMORA_PROJECT_FS_TRACE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', data => { output += data.toString() })
  child.stdin.end(JSON.stringify({ Server: urls.get('owner'), Project: 'p-files', Tokens: tokens }))
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
  const trash = await (await request('owner', '/project-files/p-files/entries?trash=1')).json() as { entries: Array<{ name: string }> }
  assert.ok(trash.entries.some(x => x.name === 'renamed.bin'), 'shell rm must retain a trash entry')
  const list = await (await request('owner', '/project-files/p-files/entries')).json() as { entries: Array<{ name: string }> }
  assert.ok(list.entries.some(x => x.name.includes('(conflict-')), 'concurrent kernel writes must retain the conflict content')
})

test('[integration] task runner hides backing files, host processes and database ports', {
  skip: !process.env.CUMORA_PROJECT_TASK_BIN,
  timeout: 45_000,
}, async () => {
  const taskHome = await mkdtemp(join(root, 'task-home-'))
  const privateFile = join(root, 'private-backing-test')
  await writeFile(privateFile, 'must not be readable by the task')
  const script = `import os, pathlib, socket, sys
assert os.getcwd() == '/home/agent'
assert not pathlib.Path(sys.argv[1]).exists(), 'host backing path leaked'
assert not pathlib.Path('/workspace').exists(), 'deployment visible'
assert not pathlib.Path('/home/box').exists(), 'operator home visible'
status = pathlib.Path('/proc/self/status').read_text()
assert 'CapEff:\\t0000000000000000' in status, status
assert 'CapBnd:\\t0000000000000000' in status, status
assert 'NoNewPrivs:\\t1' in status, status
try:
    socket.create_connection(('127.0.0.1', int(sys.argv[2])), timeout=1)
    raise AssertionError('database port reachable')
except PermissionError:
    pass
pathlib.Path('result.txt').write_text('isolated')
print('ISOLATED_OK')
`
  const child = spawn(process.env.CUMORA_PROJECT_TASK_BIN!, ['/usr/bin/python3', '-c', script, privateFile, new URL(env.DATABASE_URL).port], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', data => { output += data.toString() })
  child.stderr!.on('data', data => { output += data.toString() })
  const config = child.stdio[3] as import('node:stream').Writable
  config.end(JSON.stringify({ home: taskHome, enter: process.env.CUMORA_PROJECT_TASK_ENTER, env: {}, allowedPorts: [] }))
  child.stdin!.end()
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
  assert.match(output, /ISOLATED_OK/u)
})

test('[integration] task runner stops its namespace when the launching daemon disappears', {
  skip: !process.env.CUMORA_PROJECT_TASK_BIN, timeout: 20_000,
}, async () => {
  const lease = await testLease()
  const taskHome = await mkdtemp(join(root, 'parent-watch-task-'))
  const helper = join(root, 'launch-project-task.mjs')
  const spec = join(root, 'launch-project-task.json')
  const engine = `import pathlib,time\np=pathlib.Path('/home/agent/started'); p.write_text('ready')\nwhile True: time.sleep(.1)`
  await writeFile(spec, JSON.stringify({ binary: process.env.CUMORA_PROJECT_TASK_BIN, argv: ['/usr/bin/python3', '-c', engine],
    config: { home: taskHome, enter: process.env.CUMORA_PROJECT_TASK_ENTER, server: urls.get('owner'), project: lease.projectId, token: lease.token, env: {} } }), { mode: 0o600 })
  await writeFile(helper, `import {readFileSync,existsSync} from 'node:fs'; import {spawn} from 'node:child_process';
const spec=JSON.parse(readFileSync(process.argv[2],'utf8')); const child=spawn(spec.binary,spec.argv,{stdio:['ignore','ignore','ignore','pipe']});
child.stdio[3].end(JSON.stringify(spec.config)); console.log(child.pid); let n=0; const timer=setInterval(()=>{ if(existsSync(spec.config.home+'/started')){clearInterval(timer);console.log('READY');process.exit(0)} if(++n>100)process.exit(2) },20);`)
  const launcher = spawn(process.execPath, [helper, spec], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  launcher.stdout!.on('data', data => { output += data.toString() }); launcher.stderr!.on('data', data => { output += data.toString() })
  const [launcherCode] = await once(launcher, 'close')
  assert.equal(launcherCode, 0, output)
  assert.match(output, /READY/u)
  const runnerPid = Number(output.trim().split(/\s+/u)[0])
  assert.ok(Number.isSafeInteger(runnerPid) && runnerPid > 1, output)
  const descendants: number[] = []
  async function collect(pid: number) {
    try {
      const tasks = await readdir(`/proc/${pid}/task`)
      const children = [...new Set((await Promise.all(tasks.map(tid => readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')))).flatMap(text => text.trim().split(' ').filter(Boolean).map(Number)))]
      for (const id of children) { descendants.push(id); await collect(id) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await collect(runnerPid)
  assert.ok(descendants.length >= 2, 'inner supervisor and engine must be running before launcher death')
  const all = [runnerPid, ...descendants]
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const live = await Promise.all(all.map(async pid => {
      try { return !/\) Z /u.test(await readFile(`/proc/${pid}/stat`, 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }))
    if (live.every(value => !value)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  for (const pid of all) {
    try { assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /\) Z /u) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-files' })
})

async function testLease() {
  const runId = randomUUID()
  await pool.query('INSERT INTO agent_runs(id,agent_id,company_id) VALUES ($1,$2,$3)', [runId, 'agent', 'co-files'])
  return createProjectLease({ agentId: 'agent', companyId: 'co-files', conversationId: 'g-files', runId, bindingVersion: await binding() })
}
function mountRequest(token: string, path: string, body: unknown) {
  return fetch(`${urls.get('owner')}/project-fs${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

test('[integration] project attachments retain stable versions, private URLs and current download authorization', async () => {
  const file = await upload()
  const ref = { projectId: 'p-files', entryId: file.id, versionId: file.versionId, name: 'untrusted supplied name' }
  const sent = await request('member', '/conversations/g-files/messages', 'POST', { body: '', attachment: { projectFile: ref, url: 'https://untrusted.invalid/public', key: 'attachments/fake.txt' } })
  assert.equal(sent.status, 202, await sent.clone().text())
  const row = (await pool.query<{ attachment: { url: string; key?: string; projectFile: typeof ref; name: string } }>('SELECT attachment FROM messages WHERE id=$1', [(await sent.json() as { id: string }).id])).rows[0]
  assert.equal(row.attachment.url, '')
  assert.equal(row.attachment.key, undefined)
  assert.equal(row.attachment.name, file.name)
  await request('member', '/project-files/p-files/operations', 'POST', { requestId: randomUUID(), bindingVersion: await binding(),
    command: { type: 'upload', parentId: 'root', name: file.name, entryId: file.id, expectedVersion: file.versionId, content: Buffer.from('new content').toString('base64') } })
  const old = await request('member', `/project-files/p-files/entries/${file.id}/download?versionId=${file.versionId}`)
  assert.equal(await old.text(), 'hello', 'message still references its sent version')
  assert.equal((await request('member', '/conversations/g-empty/messages', 'POST', { attachment: { projectFile: ref } })).status, 409)
  await pool.query(`UPDATE conversations SET members='["owner","agent"]' WHERE id='g-files'`)
  assert.equal((await request('member', `/project-files/p-files/entries/${file.id}/download?versionId=${file.versionId}`)).status, 404)
})

test('[integration] copying an existing attachment never fetches an arbitrary external URL', async () => {
  await pool.query(`INSERT INTO messages(id,conversation_id,author_id,kind,body,sequence,attachment,company_id) VALUES
    ('m-external','g-files','member','text','external',1,$1::jsonb,'co-files')`, [JSON.stringify({ name: 'external.txt', kind: 'file', url: 'http://127.0.0.1:5432/private' })])
  const res = await request('member', '/project-files/p-files/save-attachment', 'POST', {
    bindingVersion: await binding(), requestId: randomUUID(), messageId: 'm-external', conversationId: 'g-files', name: 'external.txt',
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json() as { code: string }).code, 'UNSUPPORTED_ATTACHMENT')
  assert.equal((await request('outsider', '/project-files/p-files/save-attachment', 'POST', {
    bindingVersion: await binding(), requestId: randomUUID(), messageId: 'm-external', conversationId: 'g-files', name: 'external.txt',
  })).status, 404)
})

test('[integration] a stored chat attachment is copied as a private project file', async () => {
  const key = `attachments/${randomUUID()}.txt`
  const bytes = Buffer.from('Existing chat document\0binary')
  const url = await storage.put(key, bytes, 'application/octet-stream')
  try {
    await pool.query(`INSERT INTO messages(id,conversation_id,author_id,kind,body,sequence,attachment,company_id) VALUES
      ('m-stored','g-files','member','text','',1,$1::jsonb,'co-files')`, [JSON.stringify({ key, url, name: 'saved.txt', kind: 'file' })])
    const res = await request('member', '/project-files/p-files/save-attachment', 'POST', {
      bindingVersion: await binding(), requestId: randomUUID(), messageId: 'm-stored', conversationId: 'g-files', name: 'saved.txt',
    })
    assert.equal(res.status, 200, await res.clone().text())
    const saved = (await res.json() as { entry: { id: string } }).entry
    const download = await request('member', `/project-files/p-files/entries/${saved.id}/download`)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
  } finally { await storage.deleteObject(key) }
})

test('[integration] archive waits for stopped tasks and an administrator cannot edit another group project', async () => {
  assert.equal((await request('owner', '/projects/p-hidden', 'PUT', { name: 'hijack' })).status, 404)
  assert.equal((await request('owner', '/projects/p-hidden/archive', 'POST', {})).status, 404)
  const lease = await testLease()
  const waiting = await request('owner', '/projects/p-files/archive', 'POST', {})
  assert.equal(waiting.status, 409)
  assert.equal((await waiting.json() as { code: string }).code, 'TASKS_STOPPING')
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-files' })
  assert.equal((await request('owner', '/projects/p-files/archive', 'POST', {})).status, 200)
  const listing = await (await request('member', '/project-files/p-files/entries')).json() as { readOnly: boolean }
  assert.equal(listing.readOnly, true)
  assert.equal((await request('owner', '/projects/p-files/archive', 'POST', { archive: false })).status, 200)
  assert.equal((await mountRequest(lease.token, '/heartbeat', {})).status, 403)
})

test('[integration] project CLI can only read and reply within its lease, cannot mint or stop tasks', async () => {
  const file = await upload()
  const lease = await testLease()
  for (const argv of [['messages', 'g-hidden'], ['inbox'], ['workspace', 'ls'], ['reply', 'g-files', 'x', '--attach', 'http://example.invalid'], ['ack', '--all'], ['messages', 'g-files', '--as', 'owner']]) {
    assert.equal((await mountRequest(lease.token, '/cli', { argv })).status, 403, argv.join(' '))
  }
  assert.equal((await mountRequest(lease.token, '/cli', { argv: ['messages', 'g-files', '--tail', '5'] })).status, 200)
  const share = await mountRequest(lease.token, '/cli', { argv: ['project-file', file.name, 'Project document'] })
  assert.equal(share.status, 200, await share.clone().text())
  const stored = (await pool.query("SELECT attachment FROM messages WHERE author_id='agent'")).rows[0].attachment
  assert.equal(stored.projectFile.entryId, file.id)
  assert.equal(stored.url, '')
  const jwt = signAgentToken({ agentId: 'agent', companyId: 'co-files' })
  const stop = await fetch(`${urls.get('owner')}/runtime/project-files/leases/${lease.id}/stopped`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(stop.status, 403, 'even a general Agent JWT cannot acknowledge process exit')
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-files' })
  assert.equal((await mountRequest(lease.token, '/cli', { argv: ['messages', 'g-files'] })).status, 403)
})

test('[integration] real document programs read and save DOCX, XLSX and PDF through the controlled project mount', {
  skip: !process.env.CUMORA_PROJECT_TASK_BIN || !process.env.CUMORA_PROJECT_DOCUMENT_LIBS, timeout: 60_000,
}, async () => {
  const lease = await testLease()
  const taskHome = await mkdtemp(join(root, 'document-task-'))
  const libs = process.env.CUMORA_PROJECT_DOCUMENT_LIBS!
  const script = `import os, pathlib
from docx import Document
from openpyxl import Workbook, load_workbook
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
p=pathlib.Path('/projects/p-files'); (p/'docs').mkdir()
d=Document(); d.add_paragraph('Shared project document'); d.save(p/'docs/word.docx')
d=Document(p/'docs/word.docx'); assert d.paragraphs[0].text=='Shared project document'
d.add_paragraph('Edited'); d.save(p/'docs/.word.tmp'); os.replace(p/'docs/.word.tmp',p/'docs/word.docx')
assert len(Document(p/'docs/word.docx').paragraphs)==2
w=Workbook(); w.active['A1']='Shared'; w.save(p/'sheet.xlsx')
w=load_workbook(p/'sheet.xlsx'); assert w.active['A1'].value=='Shared'; w.active['B1']=42; w.save(p/'sheet.xlsx')
assert load_workbook(p/'sheet.xlsx').active['B1'].value==42
c=canvas.Canvas(str(p/'report.pdf')); c.drawString(40,700,'Shared PDF'); c.save()
r=PdfReader(p/'report.pdf'); assert 'Shared PDF' in r.pages[0].extract_text()
w=PdfWriter(); w.add_page(r.pages[0]); w.add_metadata({'/Title':'Project report'}); w.write(p/'output.pdf')
assert PdfReader(p/'output.pdf').metadata.title=='Project report'
print('DOCUMENTS_OK',flush=True)
`
  const child = spawn(process.env.CUMORA_PROJECT_TASK_BIN!, ['/usr/bin/python3', '-c', script], { env: { ...process.env, CUMORA_PROJECT_FS_TRACE: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout!.on('data', data => { output += data.toString() }); child.stderr!.on('data', data => { output += data.toString() })
  ;(child.stdio[3] as import('node:stream').Writable).end(JSON.stringify({ home: taskHome, enter: process.env.CUMORA_PROJECT_TASK_ENTER,
    server: urls.get('owner'), project: lease.projectId, token: lease.token, runtimeDirs: [libs], env: { PYTHONPATH: libs } }))
  child.stdin!.end()
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /DOCUMENTS_OK/u)
  const listing = await projectFilesFor({ kind: 'human', id: 'member', companyId: 'co-files' }).list('p-files')
  assert.ok(listing.entries.some(e => e.name === 'output.pdf' && e.size > 100))
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-files' })
})

test('[integration] revoked project task kills its whole process tree before switching is allowed', {
  skip: !process.env.CUMORA_PROJECT_TASK_BIN, timeout: 30_000,
}, async t => {
  const lease = await testLease()
  const taskHome = await mkdtemp(join(root, 'revoke-task-'))
  const script = `import os, signal, time, pathlib
signal.signal(signal.SIGTERM,signal.SIG_IGN)
if os.fork()==0:
 os.setsid()
 while True:
  pathlib.Path('/home/agent/child-alive').write_text(str(time.time()))
  time.sleep(.05)
print('READY',flush=True)
while True: time.sleep(1)
`
  const child = spawn(process.env.CUMORA_PROJECT_TASK_BIN!, ['/usr/bin/python3', '-c', script], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  t.after(() => { child.kill('SIGKILL') })
  let output = ''
  const ready = new Promise<void>(resolve => { child.stdout!.on('data', data => { output += data.toString(); if (output.includes('READY')) resolve() }) })
  child.stderr!.on('data', data => { output += data.toString() })
  const closed = once(child, 'close')
  ;(child.stdio[3] as import('node:stream').Writable).end(JSON.stringify({ home: taskHome, enter: process.env.CUMORA_PROJECT_TASK_ENTER,
    server: urls.get('owner'), project: lease.projectId, token: lease.token, env: {} }))
  child.stdin!.end()
  await Promise.race([ready, closed.then(() => { throw new Error(output || 'runner exited before READY') })])
  const descendants: number[] = []
  async function collect(pid: number) {
    const tasks = await readdir(`/proc/${pid}/task`)
    const children = [...new Set((await Promise.all(tasks.map(tid => readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')))).flatMap(text => text.trim().split(' ').filter(Boolean).map(Number)))]
    for (const id of children) { descendants.push(id); await collect(id) }
  }
  await collect(child.pid!)
  assert.ok(descendants.length >= 3, 'supervisor, engine and detached grandchild must all be present')
  assert.equal((await request('owner', '/conversations/g-files/project', 'POST', { projectId: 'p-next' })).status, 409)
  await closed
  for (const pid of descendants) {
    // A child may briefly remain a zombie until the host init reaps it; it
    // cannot execute, keep a mount alive, or access files in that state.
    try { assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /\) Z /u) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-files' })
  assert.equal((await request('owner', '/conversations/g-files/project', 'POST', { projectId: 'p-next' })).status, 200)
})

test('[integration] engine spawn wrapper keeps host secrets outside an actual task process', {
  skip: !process.env.CUMORA_PROJECT_TASK_BIN, timeout: 30_000,
}, async () => {
  const home = await mkdtemp(join(root, 'wrapper-task-'))
  const child = withTaskSandbox({ binary: process.env.CUMORA_PROJECT_TASK_BIN!, enter: process.env.CUMORA_PROJECT_TASK_ENTER!, home, server: urls.get('owner')! }, () =>
    spawnTaskProcess('/usr/bin/node', ['-e', `const fs=require('fs'); if(process.env.DATABASE_URL||process.env.CUMORA_PROJECT_HOST_SECRET||process.env.NODE_OPTIONS)process.exit(2); if(process.cwd()!='/home/agent')process.exit(3); fs.writeFileSync('ok.txt','bounded'); console.log('WRAPPER_OK')`],
      { cwd: home, env: { ...process.env, DATABASE_URL: 'host-private', CUMORA_PROJECT_HOST_SECRET: 'host-private', NODE_OPTIONS: '--require /not-allowed' }, stdio: ['pipe', 'pipe', 'pipe'] }))
  let output = ''
  child.stdout!.on('data', data => { output += data.toString() }); child.stderr!.on('data', data => { output += data.toString() })
  child.stdin!.end()
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /WRAPPER_OK/u)
  assert.equal(await readFile(join(home, 'ok.txt'), 'utf8'), 'bounded')
})

test('[integration] stopped-task recovery never acknowledges a live process or revives a pre-restart lease', { timeout: 15_000 }, async t => {
  const lease = await testLease()
  const originalSecret = process.env.CUMORA_PROJECT_HOST_SECRET, originalApi = process.env.CUMORA_PROJECT_LOCAL_API
  process.env.CUMORA_PROJECT_HOST_SECRET = 'isolated-host-secret-for-recovery-test'
  process.env.CUMORA_PROJECT_LOCAL_API = urls.get('owner')
  t.after(() => {
    if (originalSecret === undefined) delete process.env.CUMORA_PROJECT_HOST_SECRET; else process.env.CUMORA_PROJECT_HOST_SECRET = originalSecret
    if (originalApi === undefined) delete process.env.CUMORA_PROJECT_LOCAL_API; else process.env.CUMORA_PROJECT_LOCAL_API = originalApi
  })
  const tracked = await trackProjectTask('agent', lease)
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  t.after(() => { child.kill('SIGKILL') })
  const closed = once(child, 'close')
  await tracked.onSpawn(child)
  const jwt = signAgentToken({ agentId: 'agent', companyId: 'co-files' })
  await assert.rejects(tracked.stopped(jwt), /still running/u)
  await recoverProjectStops('agent', jwt)
  assert.equal((await pool.query('SELECT stopped_at FROM project_file_leases WHERE id=$1', [lease.id])).rows[0].stopped_at, null)
  // A new API instance invalidates every previous instance token immediately.
  await pool.query("UPDATE project_file_leases SET server_instance='previous-api-instance' WHERE id=$1", [lease.id])
  assert.equal((await mountRequest(lease.token, '/heartbeat', {})).status, 403)
  assert.equal((await request('owner', '/conversations/g-files/project', 'POST', { projectId: 'p-next' })).status, 409)
  child.kill('SIGKILL'); await closed
  await recoverProjectStops('agent', jwt)
  assert.ok((await pool.query('SELECT stopped_at FROM project_file_leases WHERE id=$1', [lease.id])).rows[0].stopped_at)
  assert.equal((await request('owner', '/conversations/g-files/project', 'POST', { projectId: 'p-next' })).status, 200)
  assert.equal((await mountRequest(lease.token, '/heartbeat', {})).status, 403)
})

for (const engineId of ['codex', 'grok'] as const) test(`[integration] actual ${engineId} engine completes a task against the private project filesystem`, {
  skip: process.env[engineId === 'codex' ? 'CUMORA_PROJECT_ENGINE_SMOKE' : 'CUMORA_PROJECT_GROK_SMOKE'] !== '1', timeout: 150_000,
}, async () => {
  const lease = await testLease()
  const home = await mkdtemp(join(root, 'engine-smoke-'))
  await prepareTaskAuth(home)
  const engine = process.env[engineId === 'codex' ? 'CUMORA_PROJECT_ENGINE_BINARY' : 'CUMORA_PROJECT_GROK_BINARY']!
  const commandPath = engineId === 'grok' ? join(dirname(dirname(engine)), 'bin') : dirname(engine)
  const prompt = 'This is an isolated Cumora filesystem acceptance test. Do exactly this task, no directory scans or other work: use a shell command to write the exact UTF-8 text CUMORA_ENGINE_OK into /projects/p-files/engine-smoke.txt, then read that exact file and report whether it matches. Do not access network resources or any other files. The project directory is an available filesystem, not standing context.'
  let log = ''
  const result = await withTaskSandbox({ binary: process.env.CUMORA_PROJECT_TASK_BIN!, enter: process.env.CUMORA_PROJECT_TASK_ENTER!,
    home, server: urls.get('owner')!, project: lease.projectId, token: lease.token, runtimeDirs: [engine.slice(0, engine.lastIndexOf('/'))] }, () => getAdapter(engineId).run({
    home, prompt, env: { PATH: `${commandPath}:/usr/bin:/bin` },
    resumeSessionId: null, signal: AbortSignal.timeout(120_000), onLog: line => { log = (log + '\n' + line).slice(-4000) },
  }))
  assert.equal(result.exitCode, 0, `Engine task failed: ${result.error ?? log}`)
  const service = projectFilesFor({ kind: 'human', id: 'member', companyId: 'co-files' })
  const saved = (await service.list('p-files')).entries.find(e => e.name === 'engine-smoke.txt')
  assert.ok(saved, `The real engine must create the actual project file, not just describe it. Engine output: ${log}`)
  assert.equal((await service.read('p-files', saved.id)).content.toString().trim(), 'CUMORA_ENGINE_OK')
  await stopProjectLease({ id: lease.id, agentId: 'agent', companyId: 'co-files' })
})
