import assert from 'node:assert/strict'
import test from 'node:test'
import { ProjectFileError } from '../project-files/model.js'
import { normalizeBranch, normalizeRepositoryName, normalizeRepositoryUrl } from '../project-git/model.js'
import { openGitToken, sealGitToken } from '../project-git/token-vault.js'

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
  assert.equal(normalizeRepositoryName(' Web app '), 'Web app')
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
