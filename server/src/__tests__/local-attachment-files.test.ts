/**
 * Regression tests for local attachment path containment.
 *
 * Run: node --import tsx --test server/src/__tests__/local-attachment-files.test.ts
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { readLocalMessageAttachment } from '../local-attachment-files.js'

const tempRoots = new Set<string>()

async function fixture(): Promise<{ root: string; uploads: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-local-attachment-'))
  tempRoots.add(root)
  const uploads = join(root, 'uploads')
  await mkdir(join(uploads, 'attachments'), { recursive: true })
  return { root, uploads }
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.clear()
})

test('reads a regular attachment inside the upload root', async () => {
  const { uploads } = await fixture()
  await writeFile(join(uploads, 'attachments', 'note.txt'), 'safe content')

  const data = await readLocalMessageAttachment(uploads, 'attachments/note.txt')

  assert.equal(data?.toString('utf8'), 'safe content')
})

test('rejects a final symlink whose target escapes the upload root', {
  // Creating file symlinks requires Developer Mode or elevation on Windows;
  // the directory-junction case below still exercises physical containment.
  skip: process.platform === 'win32',
}, async () => {
  const { root, uploads } = await fixture()
  const secret = join(root, 'secret.txt')
  await writeFile(secret, 'outside content')
  await symlink(secret, join(uploads, 'attachments', 'linked.txt'))

  const data = await readLocalMessageAttachment(uploads, 'attachments/linked.txt')

  assert.equal(data, null)
})

test('rejects an attachment reached through a directory symlink that escapes', async () => {
  const { root, uploads } = await fixture()
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'outside content')
  await symlink(
    outside,
    join(uploads, 'attachments', 'linked-dir'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  const data = await readLocalMessageAttachment(
    uploads,
    'attachments/linked-dir/secret.txt',
  )

  assert.equal(data, null)
})

test('rejects non-attachment keys, missing files, and directories', async () => {
  const { uploads } = await fixture()
  await mkdir(join(uploads, 'attachments', 'folder'))

  assert.equal(await readLocalMessageAttachment(uploads, 'avatars/person.txt'), null)
  assert.equal(await readLocalMessageAttachment(uploads, 'attachments/missing.txt'), null)
  assert.equal(await readLocalMessageAttachment(uploads, 'attachments/folder'), null)
})
