import test from 'node:test'
import assert from 'node:assert/strict'
import { ProjectFileError } from '../project-files/model.js'
import { normalizeBranch, normalizeGitHost, normalizeRepositoryUrl } from '../project-git/model.js'
import { openGitToken, sealGitToken } from '../project-git/token-vault.js'
import { prepareTaskRepository } from '../agents/computer/project-task.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileP = promisify(execFile)

test('Git token vault encrypts with tenant and credential binding', () => {
  const args = { token: 'github_pat_example_secret', companyId: 'co-a', credentialId: 'cred-a', secret: 'vault-secret' }
  const sealed = sealGitToken(args)
  assert.ok(!sealed.includes(args.token))
  assert.equal(openGitToken({ sealed, companyId: 'co-a', credentialId: 'cred-a', secret: 'vault-secret' }), args.token)
  assert.equal(openGitToken({ sealed, companyId: 'co-b', credentialId: 'cred-a', secret: 'vault-secret' }), null)
  assert.equal(openGitToken({ sealed, companyId: 'co-a', credentialId: 'cred-b', secret: 'vault-secret' }), null)
  assert.equal(openGitToken({ sealed: `${sealed}x`, companyId: 'co-a', credentialId: 'cred-a', secret: 'vault-secret' }), null)
})

test('Git configuration accepts credential-free HTTPS and safe branch names', () => {
  assert.deepEqual(normalizeRepositoryUrl('https://GitHub.com/acme/repo.git'), { url: 'https://github.com/acme/repo.git', host: 'github.com' })
  assert.equal(normalizeGitHost('GitHub.com'), 'github.com')
  assert.equal(normalizeBranch('feature/project-git'), 'feature/project-git')
  assert.equal(normalizeBranch(''), null)
})

test('Git configuration rejects credentials, non-HTTPS, local targets and malformed refs', () => {
  for (const value of ['http://github.com/acme/repo.git', 'https://token@github.com/acme/repo.git',
    'https://127.0.0.1/repo.git', 'https://localhost/repo.git', 'file:///tmp/repo.git']) {
    assert.throws(() => normalizeRepositoryUrl(value), ProjectFileError)
  }
  for (const value of ['../main', '-danger', 'bad branch', 'refs/heads/x.lock', 'feature//x']) {
    assert.throws(() => normalizeBranch(value), ProjectFileError)
  }
})

test('Linux project task gets a token-free independent checkout and can switch branches', { skip: process.platform !== 'linux', timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-project-git-'))
  const source = join(root, 'source'), mirror = join(root, 'mirrors', 'project.git'), home = join(root, 'task-home')
  const oldRoot = process.env.CUMORA_PROJECT_GIT_ROOT
  try {
    await Promise.all([mkdir(source, { recursive: true }), mkdir(join(root, 'mirrors'), { recursive: true }), mkdir(home)])
    await execFileP('git', ['init', '-b', 'main'], { cwd: source })
    await execFileP('git', ['config', 'user.name', 'Cumora Test'], { cwd: source })
    await execFileP('git', ['config', 'user.email', 'cumora@test.local'], { cwd: source })
    await writeFile(join(source, 'branch.txt'), 'main\n')
    await execFileP('git', ['add', '.'], { cwd: source }); await execFileP('git', ['commit', '-m', 'main'], { cwd: source })
    const commit = (await execFileP('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
    await execFileP('git', ['switch', '-c', 'feature/test'], { cwd: source })
    await writeFile(join(source, 'feature.txt'), 'feature\n'); await execFileP('git', ['add', '.'], { cwd: source }); await execFileP('git', ['commit', '-m', 'feature'], { cwd: source })
    await execFileP('git', ['clone', '--mirror', source, mirror])
    process.env.CUMORA_PROJECT_GIT_ROOT = root
    const prepared = await prepareTaskRepository(home, { repositoryUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main', mirrorPath: mirror, commit })
    assert.deepEqual(prepared, { path: '/home/agent/repository', branch: 'main' })
    const checkout = join(home, 'repository')
    assert.equal((await execFileP('git', ['branch', '--show-current'], { cwd: checkout })).stdout.trim(), 'main')
    assert.equal((await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: checkout })).stdout.trim(), 'https://github.com/acme/repo.git')
    assert.ok(!(await readFile(join(checkout, '.git', 'config'), 'utf8')).includes(root))
    await execFileP('git', ['switch', 'feature/test'], { cwd: checkout })
    assert.equal((await readFile(join(checkout, 'feature.txt'), 'utf8')).trim(), 'feature')
  } finally {
    if (oldRoot === undefined) delete process.env.CUMORA_PROJECT_GIT_ROOT; else process.env.CUMORA_PROJECT_GIT_ROOT = oldRoot
    await rm(root, { recursive: true, force: true })
  }
})
