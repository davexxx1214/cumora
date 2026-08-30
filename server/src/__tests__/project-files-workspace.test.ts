import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { emptyProjectState, ProjectFileError, type ProjectFileState } from '../project-files/model.js'
import { LocalProjectObjects } from '../project-files/objects.js'
import { type FileCommand, type FileScope, type FileTransaction, ProjectFileWorkspace } from '../project-files/workspace.js'

async function fixture(t: TestContext, quotaBytes = 100_000) {
  const root = await mkdtemp(join(tmpdir(), 'cumora-project-files-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let state = emptyProjectState()
  let tail: Promise<unknown> = Promise.resolve()
  let allowed = true
  const scope: FileScope = { projectId: 'p-test', actor: { id: 'alice', name: 'Alice', kind: 'human' },
    admin: false, bindingVersion: 'binding-one', leaseId: null, quotaBytes }
  const authorize = async () => { if (!allowed) throw new ProjectFileError('REVOKED', 403, 'Revoked') }
  const objects = new LocalProjectObjects(root)
  const api = new ProjectFileWorkspace({
    withProject<T>(projectId: string, work: (tx: FileTransaction) => Promise<T>): Promise<T> {
      const currentScope = structuredClone(scope)
      const result = tail.then(async () => {
        await authorize()
        assert.equal(projectId, 'p-test')
        const copy: ProjectFileState = structuredClone(state)
        const value = await work({ state: copy, scope: currentScope, authorize })
        state = copy
        return value
      })
      tail = result.catch(() => {})
      return result
    },
  }, objects)
  const run = (command: FileCommand, key = randomUUID()) => api.execute('p-test', key, command)
  const upload = async (name: string, content: Buffer | string, parentId = 'root') => {
    const result = await run({ type: 'upload', name, parentId, content: Buffer.from(content).toString('base64') })
    return result.entry!
  }
  return { root, api, run, upload, scope, objects, state: () => state, revoke: () => { allowed = false } }
}
const error = (code: string) => (e: unknown) => e instanceof ProjectFileError && e.code === code

test('project files: binary files, Unicode directories, empty files and idempotent uploads', async t => {
  const f = await fixture(t)
  const directory = (await f.run({ type: 'mkdir', parentId: 'root', name: '资料 空格' })).entry!
  const bytes = Buffer.from([0, 255, 2, 127, 0, 99])
  const file = await f.upload('data.bin', bytes, directory.id)
  assert.deepEqual((await f.api.read('p-test', file.id)).content, bytes)
  const listing = await f.api.list('p-test', directory.id)
  assert.deepEqual(listing.ancestors.map(x => x.name), ['', '资料 空格'])
  assert.equal(listing.usedBytes, bytes.length)
  const key = randomUUID()
  const cmd: FileCommand = { type: 'upload', parentId: 'root', name: 'empty.txt', content: '' }
  assert.deepEqual(await f.run(cmd, key), await f.run(cmd, key))
  assert.equal((await f.api.list('p-test')).entries.length, 2)
  await assert.rejects(f.run({ ...cmd, name: 'different.txt' }, key), error('IDEMPOTENCY_CONFLICT'))
})

test('project files: Git worktrees share quota, are human read-only and remain Agent-writable with dirty tracking', async t => {
  const f = await fixture(t)
  f.scope.system = true; f.scope.admin = true; f.scope.actor = { id: 'git-service', name: 'Git service', kind: 'human' }
  const imported = await f.api.importGitTree('p-test', 'repo-one', 'Web', [
    { path: 'README.md', content: Buffer.from('base') }, { path: 'src/app.ts', content: Buffer.from('export {}') },
  ])
  assert.equal((await f.api.list('p-test')).usedBytes, 13)
  f.scope.system = false; f.scope.admin = false; f.scope.actor = { id: 'alice', name: 'Alice', kind: 'human' }
  const root = await f.api.list('p-test', imported.rootEntryId)
  const readme = root.entries.find(item => item.name === 'README.md')!
  assert.equal((await f.api.read('p-test', readme.id)).content.toString(), 'base')
  f.scope.system = true
  await assert.rejects(f.api.importGitTree('p-test', 'repo-one', 'Web', [
    { path: 'too-large-for-test-quota.bin', content: Buffer.alloc(100_001) },
  ]), error('QUOTA_EXCEEDED'))
  assert.equal((await f.api.read('p-test', readme.id)).content.toString(), 'base', 'a failed replacement keeps the previous worktree bytes')
  f.scope.system = false
  await assert.rejects(f.run({ type: 'upload', parentId: imported.rootEntryId, entryId: readme.id, name: readme.name,
    expectedVersion: readme.versionId!, content: Buffer.from('human').toString('base64') }), error('GIT_READ_ONLY'))
  await assert.rejects(f.run({ type: 'mkdir', parentId: imported.rootEntryId, name: 'human-folder' }), error('GIT_READ_ONLY'))
  f.scope.actor = { id: 'agent', name: 'Agent', kind: 'agent' }; f.scope.leaseId = 'lease-one'
  await f.run({ type: 'upload', parentId: imported.rootEntryId, entryId: readme.id, name: readme.name,
    expectedVersion: readme.versionId!, content: Buffer.from('agent').toString('base64') })
  assert.equal((await f.api.exportGitTree('p-test', 'repo-one')).dirty, true)
  f.scope.system = true; f.scope.actor = { id: 'git-service', name: 'Git service', kind: 'human' }; f.scope.leaseId = null
  await f.api.markGitCommitted('p-test', 'repo-one')
  assert.equal((await f.api.exportGitTree('p-test', 'repo-one')).dirty, false)
})

test('project files: the Git worktree container name is reserved at the project root', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ type: 'mkdir', parentId: 'root', name: 'Repositories' }), error('RESERVED_NAME'))
  await assert.rejects(f.upload('Repositories', 'ordinary file'), error('RESERVED_NAME'))
  const ordinary = await f.upload('ordinary', 'content')
  await assert.rejects(f.run({ type: 'move', entryId: ordinary.id, expectedRevision: ordinary.revision,
    parentId: 'root', name: 'Repositories' }), error('RESERVED_NAME'))
})

test('project files: concurrent overwrites conflict; independent mount writes retain conflicting bytes', async t => {
  const f = await fixture(t)
  const file = await f.upload('report.txt', 'base')
  const begin = () => f.run({ type: 'begin-write', entryId: file.id, expectedVersion: file.versionId })
  const [a, b] = await Promise.all([begin(), begin()])
  for (const result of [a, b]) await f.run({ type: 'reserve-write', writeId: result.write!.id, size: 6 })
  const first = await f.run({ type: 'commit-write', writeId: a.write!.id, content: Buffer.from('first!').toString('base64') })
  const second = await f.run({ type: 'commit-write', writeId: b.write!.id, content: Buffer.from('second').toString('base64') })
  assert.equal(first.conflict, false); assert.equal(second.conflict, true)
  assert.notEqual(second.entry!.id, file.id)
  assert.equal((await f.api.read('p-test', file.id)).content.toString(), 'first!')
  assert.equal((await f.api.read('p-test', second.entry!.id)).content.toString(), 'second')
  await assert.rejects(f.run({ type: 'upload', entryId: file.id, expectedVersion: file.versionId!, name: file.name,
    parentId: 'root', content: '' }), error('CONFLICT'))
})

test('project files: temp rename checks the version read before editing and preserves stable target IDs', async t => {
  const f = await fixture(t)
  const target = await f.upload('report.docx', 'original')
  const temp = await f.upload('.editor-temp', 'new document')
  const update = await f.run({ type: 'upload', entryId: target.id, expectedVersion: target.versionId!, parentId: 'root', name: target.name,
    content: Buffer.from('another author').toString('base64') })
  const replace: FileCommand = { type: 'move', entryId: temp.id, expectedRevision: temp.revision, parentId: 'root', name: target.name,
    targetId: target.id, expectedTargetVersion: target.versionId! }
  await assert.rejects(f.run(replace), error('CONFLICT'))
  assert.equal((await f.api.read('p-test', temp.id)).content.toString(), 'new document')
  const replaced = await f.run({ ...replace, expectedTargetVersion: update.entry!.versionId! })
  assert.equal(replaced.entry!.id, target.id)
  assert.equal((await f.api.read('p-test', target.id)).content.toString(), 'new document')
  assert.equal((await f.api.read('p-test', target.id, target.versionId!)).content.toString(), 'original')
  assert.equal((await f.api.list('p-test', 'root', true)).entries[0].id, temp.id)
})

test('project files: recursive trash retains bytes, restore never overwrites, only human admins purge', async t => {
  const f = await fixture(t)
  const dir = (await f.run({ type: 'mkdir', parentId: 'root', name: 'folder' })).entry!
  const file = await f.upload('a.txt', 'hello', dir.id)
  await assert.rejects(f.run({ type: 'trash', entryId: dir.id, expectedRevision: dir.revision }), error('DIRECTORY_NOT_EMPTY'))
  await f.run({ type: 'trash', entryId: dir.id, expectedRevision: dir.revision, recursive: true })
  await assert.rejects(f.api.read('p-test', file.id), error('NOT_FOUND'))
  const trashed = (await f.api.list('p-test', 'root', true)).entries[0]
  assert.equal((await f.api.list('p-test')).usedBytes, 5)
  await f.run({ type: 'mkdir', parentId: 'root', name: 'folder' })
  await assert.rejects(f.run({ type: 'restore', entryId: dir.id, expectedRevision: trashed.revision, parentId: 'root', name: 'folder' }), error('ALREADY_EXISTS'))
  await assert.rejects(f.run({ type: 'purge', entryId: dir.id, expectedRevision: trashed.revision, confirm: true }), error('ADMIN_REQUIRED'))
  const restored = (await f.run({ type: 'restore', entryId: dir.id, expectedRevision: trashed.revision, parentId: 'root', name: 'restored' })).entry!
  assert.equal((await f.api.read('p-test', file.id)).content.toString(), 'hello')
  await f.run({ type: 'trash', entryId: dir.id, expectedRevision: restored.revision, recursive: true })
  f.scope.admin = true
  const trash = (await f.api.list('p-test', 'root', true)).entries[0]
  await f.run({ type: 'purge', entryId: dir.id, expectedRevision: trash.revision, confirm: true })
  assert.equal((await f.api.list('p-test')).usedBytes, 0)
})

test('project files: quota includes versions, trash, conflict content and concurrent reservations', async t => {
  const f = await fixture(t, 10)
  const file = await f.upload('a', '12345')
  const a = (await f.run({ type: 'begin-write', entryId: file.id, expectedVersion: file.versionId })).write!
  const b = (await f.run({ type: 'begin-write', entryId: file.id, expectedVersion: file.versionId })).write!
  const attempts = await Promise.allSettled([f.run({ type: 'reserve-write', writeId: a.id, size: 5 }), f.run({ type: 'reserve-write', writeId: b.id, size: 5 })])
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1)
  const committed = (await f.run({ type: 'commit-write', writeId: a.id, content: Buffer.from('67890').toString('base64') })).entry!
  await f.run({ type: 'abort-write', writeId: b.id })
  assert.equal((await f.api.list('p-test')).usedBytes, 10)
  await f.run({ type: 'trash', entryId: file.id, expectedRevision: committed.revision })
  await assert.rejects(f.upload('another', 'x'), error('QUOTA_EXCEEDED'))
  assert.equal((await f.api.list('p-test')).entries.length, 0)
})

test('project files: current listing drops lost content and does not resurrect a previous version', async t => {
  const f = await fixture(t)
  const file = await f.upload('lost.pdf', 'old')
  const updated = (await f.run({ type: 'upload', entryId: file.id, expectedVersion: file.versionId!, parentId: 'root', name: file.name,
    content: Buffer.from('new').toString('base64') })).entry!
  const head = f.state().entries[file.id].versions.find(v => v.id === updated.versionId)!
  await f.objects.remove('p-test', head.objectId)
  const listing = await f.api.list('p-test')
  assert.equal(listing.entries.length, 0)
  assert.equal(listing.usedBytes, 3)
  await assert.rejects(f.api.read('p-test', file.id), error('NOT_FOUND'))
  await assert.rejects(f.run({ type: 'purge-missing-history', confirm: true }), error('ADMIN_REQUIRED'))
  f.scope.admin = true
  assert.equal((await f.api.list('p-test')).unavailableCount, 1)
  await f.run({ type: 'purge-missing-history', confirm: true })
  assert.equal((await f.api.list('p-test')).usedBytes, 0)
  const replacement = await f.upload('lost.pdf', 'fresh')
  assert.notEqual(replacement.id, file.id)
  // Simulate host loss only inside our own disposable test directory.
  for (const name of await readdir(join(f.root, 'p-test'))) await unlink(join(f.root, 'p-test', name))
  assert.equal((await f.api.list('p-test')).usedBytes, 0)
  assert.equal((await f.api.list('p-test')).entries.length, 0)
})

test('project files: streaming authorization rejects a purged historical version', async t => {
  const f = await fixture(t)
  const first = await f.upload('report', 'original')
  const latest = (await f.run({ type: 'upload', entryId: first.id, expectedVersion: first.versionId!, parentId: 'root', name: first.name,
    content: Buffer.from('changed').toString('base64') })).entry!
  await f.api.assertReadable('p-test', first.id, first.versionId!)
  f.scope.admin = true
  await f.run({ type: 'purge-history', entryId: latest.id, expectedRevision: latest.revision, confirm: true })
  await assert.rejects(f.api.assertReadable('p-test', first.id, first.versionId!), error('CONTENT_MISSING'))
  await f.api.assertReadable('p-test', latest.id, latest.versionId!)
})

test('project files: revoked identity, binding changes, expiry and foreign write IDs fail closed', async t => {
  const f = await fixture(t)
  const file = await f.upload('a', 'base')
  const write = (await f.run({ type: 'begin-write', entryId: file.id, expectedVersion: file.versionId })).write!
  f.scope.actor = { id: 'bob', name: 'Bob', kind: 'human' }
  await assert.rejects(f.run({ type: 'reserve-write', writeId: write.id, size: 1 }), error('WRITE_EXPIRED'))
  f.scope.actor = { id: 'alice', name: 'Alice', kind: 'human' }
  f.scope.bindingVersion = 'new-binding'
  await assert.rejects(f.run({ type: 'reserve-write', writeId: write.id, size: 1 }), error('WRITE_EXPIRED'))
  f.revoke()
  await assert.rejects(f.api.read('p-test', file.id), error('REVOKED'))
  await assert.rejects(f.api.list('p-test'), error('REVOKED'))
})

test('project files: invalid names, link objects, special entries and directory cycles are rejected', async t => {
  const f = await fixture(t)
  for (const name of ['..', '../escape', 'a/b', 'a\\b', 'nul\0', '']) await assert.rejects(f.upload(name, ''), error('INVALID_NAME'))
  await assert.rejects(f.api.stat('p-test', '__proto__'), error('NOT_FOUND'))
  const dir = (await f.run({ type: 'mkdir', parentId: 'root', name: 'a' })).entry!
  const child = (await f.run({ type: 'mkdir', parentId: dir.id, name: 'b' })).entry!
  await assert.rejects(f.run({ type: 'move', entryId: dir.id, expectedRevision: dir.revision, parentId: child.id, name: 'cycle' }), error('DIRECTORY_CYCLE'))
  await writeFile(join(f.root, 'p-test', 'unexpected'), 'untrusted')
  await assert.rejects(f.api.list('p-test'), error('UNSAFE_STORAGE'))
})

test('project files: no symlink data roots (Linux)', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'cumora-project-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(f.root, 'linked'))
  await assert.rejects(new LocalProjectObjects(join(f.root, 'linked')).inventory('p-test'), error('UNSAFE_STORAGE'))
  await chmod(f.root, 0o755)
  await assert.rejects(f.objects.inventory('p-test'), error('UNSAFE_STORAGE'))
})
