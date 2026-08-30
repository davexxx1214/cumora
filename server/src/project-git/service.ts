import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { requireProjectManager } from '../project-files/bindings.js'
import { fail } from '../project-files/model.js'
import { isPrivateLiteral, normalizeBranch, normalizeGitHost, normalizeRepositoryUrl, type ProjectGitSettings } from './model.js'
import { openGitToken, sealGitToken } from './token-vault.js'

const execFileP = promisify(execFile)
const syncQueues = new Map<string, Promise<unknown>>()

export interface GitCredentialSummary {
  id: string
  name: string
  host: string
  username: string
  tokenHint: string
  active: boolean
  createdAt: string
  updatedAt: string
}

interface CredentialRow {
  id: string; company_id: string; name: string; host: string; username: string
  token_encrypted: string; token_hint: string; active: boolean
  created_at: string; updated_at: string
}

interface SettingRow {
  project_id: string; repository_url: string; default_branch: string | null
  resolved_default_branch: string | null; sync_status: ProjectGitSettings['syncStatus']
  sync_error: string | null; last_synced_at: string | null; last_commit: string | null
}

function summary(row: CredentialRow): GitCredentialSummary {
  return { id: row.id, name: row.name, host: row.host, username: row.username, tokenHint: row.token_hint,
    active: row.active, createdAt: row.created_at, updatedAt: row.updated_at }
}

function settings(row: SettingRow): ProjectGitSettings {
  return { projectId: row.project_id, repositoryUrl: row.repository_url, defaultBranch: row.default_branch,
    resolvedDefaultBranch: row.resolved_default_branch, syncStatus: row.sync_status, syncError: row.sync_error,
    lastSyncedAt: row.last_synced_at, lastCommit: row.last_commit }
}

export function requireProjectGit(): void {
  if (!env.PROJECT_GIT_ENABLED || !env.PROJECT_GIT_ROOT) fail('PROJECT_GIT_DISABLED', 503, 'Project Git is not enabled on this host.')
  if (!isAbsolute(env.PROJECT_GIT_ROOT)) fail('PROJECT_GIT_DISABLED', 503, 'Project Git root must be an absolute path.')
}

function tokenHint(token: string): string {
  const tail = [...token].slice(-4).join('')
  return tail ? `••••${tail}` : '••••'
}

function validateToken(value: unknown): string {
  const token = String(value ?? '')
  if (token.length < 8 || token.length > 4_096 || /[\x00\r\n]/u.test(token)) fail('INVALID_GIT_TOKEN', 400, 'Enter a valid Git access token.')
  return token
}

function validateUsername(value: unknown): string {
  const username = String(value ?? '').trim()
  if (!username || username.length > 200 || /[\x00\r\n]/u.test(username)) fail('INVALID_GIT_USERNAME', 400, 'Enter the Git username used with this token.')
  return username
}

function validateName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (!name || name.length > 80) fail('INVALID_GIT_CREDENTIAL_NAME', 400, 'Enter a credential name of at most 80 characters.')
  return name
}

export async function listGitCredentials(companyId: string): Promise<GitCredentialSummary[]> {
  const { rows } = await pool.query<CredentialRow>(`SELECT id, company_id, name, host, username, token_encrypted, token_hint, active,
    created_at::text, updated_at::text FROM company_git_credentials WHERE company_id=$1 ORDER BY active DESC, created_at DESC`, [companyId])
  return rows.map(summary)
}

export async function createGitCredential(args: { companyId: string; userId: string; name: unknown; host: unknown; username: unknown; token: unknown; active: boolean }): Promise<GitCredentialSummary> {
  const id = `gitcred-${randomUUID()}`
  const name = validateName(args.name), host = normalizeGitHost(args.host), username = validateUsername(args.username), token = validateToken(args.token)
  const sealed = sealGitToken({ token, companyId: args.companyId, credentialId: id, secret: env.GIT_CREDENTIAL_ENCRYPTION_SECRET })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE', [args.companyId])
    if (args.active) await client.query('UPDATE company_git_credentials SET active=FALSE, updated_at=NOW() WHERE company_id=$1 AND active', [args.companyId])
    const { rows } = await client.query<CredentialRow>(`INSERT INTO company_git_credentials
      (id, company_id, name, host, username, token_encrypted, token_hint, active, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, company_id, name, host, username, token_encrypted, token_hint, active, created_at::text, updated_at::text`,
    [id, args.companyId, name, host, username, sealed, tokenHint(token), args.active, args.userId])
    await client.query('COMMIT')
    return summary(rows[0])
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function updateGitCredential(args: { companyId: string; id: string; name?: unknown; host?: unknown; username?: unknown; token?: unknown }): Promise<GitCredentialSummary> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query<CredentialRow>('SELECT * FROM company_git_credentials WHERE id=$1 AND company_id=$2 FOR UPDATE', [args.id, args.companyId])
    if (!existing.rows[0]) fail('NOT_FOUND', 404, 'Git credential not found.')
    const row = existing.rows[0]
    const name = args.name === undefined ? row.name : validateName(args.name)
    const host = args.host === undefined ? row.host : normalizeGitHost(args.host)
    const username = args.username === undefined ? row.username : validateUsername(args.username)
    const token = args.token === undefined || args.token === '' ? null : validateToken(args.token)
    const encrypted = token ? sealGitToken({ token, companyId: args.companyId, credentialId: args.id, secret: env.GIT_CREDENTIAL_ENCRYPTION_SECRET }) : row.token_encrypted
    const { rows } = await client.query<CredentialRow>(`UPDATE company_git_credentials SET name=$3, host=$4, username=$5,
      token_encrypted=$6, token_hint=$7, updated_at=NOW() WHERE id=$1 AND company_id=$2
      RETURNING id, company_id, name, host, username, token_encrypted, token_hint, active, created_at::text, updated_at::text`,
    [args.id, args.companyId, name, host, username, encrypted, token ? tokenHint(token) : row.token_hint])
    await client.query('COMMIT')
    return summary(rows[0])
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function activateGitCredential(companyId: string, id: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE', [companyId])
    const found = await client.query('SELECT 1 FROM company_git_credentials WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId])
    if (!found.rows[0]) fail('NOT_FOUND', 404, 'Git credential not found.')
    await client.query('UPDATE company_git_credentials SET active=FALSE, updated_at=NOW() WHERE company_id=$1 AND active', [companyId])
    await client.query('UPDATE company_git_credentials SET active=TRUE, updated_at=NOW() WHERE id=$1', [id])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function deleteGitCredential(companyId: string, id: string): Promise<void> {
  const result = await pool.query('DELETE FROM company_git_credentials WHERE id=$1 AND company_id=$2', [id, companyId])
  if (!result.rowCount) fail('NOT_FOUND', 404, 'Git credential not found.')
}

async function projectVisible(companyId: string, userId: string, projectId: string): Promise<boolean> {
  const { rows } = await pool.query<{ role: string }>(`SELECT cm.role FROM projects p JOIN company_members cm
    ON cm.company_id=p.company_id AND cm.user_id=$3 WHERE p.id=$1 AND p.company_id=$2 AND (
    EXISTS (SELECT 1 FROM conversations c WHERE c.project_id=p.id AND c.members @> jsonb_build_array($3::text))
    OR (NOT EXISTS (SELECT 1 FROM conversations c WHERE c.project_id=p.id) AND cm.role IN ('owner','admin')))`, [projectId, companyId, userId])
  if (!rows[0]) fail('NOT_FOUND', 404, 'Project not found.')
  return ['owner', 'admin'].includes(rows[0].role)
}

export async function getProjectGitSettings(companyId: string, userId: string, projectId: string): Promise<ProjectGitSettings | null> {
  const admin = await projectVisible(companyId, userId, projectId)
  const { rows } = await pool.query<SettingRow>(`SELECT project_id, repository_url, default_branch, resolved_default_branch,
    sync_status, sync_error, last_synced_at::text, last_commit FROM project_git_settings WHERE project_id=$1`, [projectId])
  if (!rows[0]) return null
  const value = settings(rows[0])
  return admin ? value : { ...value, syncError: null }
}

export async function saveProjectGitSettings(args: { companyId: string; userId: string; projectId: string; repositoryUrl: unknown; defaultBranch: unknown }): Promise<ProjectGitSettings> {
  requireProjectGit()
  const repository = normalizeRepositoryUrl(args.repositoryUrl)
  const branch = normalizeBranch(args.defaultBranch)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, args.companyId, args.userId, args.projectId)
    const { rows } = await client.query<SettingRow>(`INSERT INTO project_git_settings
      (project_id, repository_url, default_branch, sync_status, sync_error, resolved_default_branch, last_synced_at, last_commit, updated_by)
      VALUES ($1,$2,$3,'not_synced',NULL,NULL,NULL,NULL,$4)
      ON CONFLICT (project_id) DO UPDATE SET repository_url=EXCLUDED.repository_url, default_branch=EXCLUDED.default_branch,
        sync_status=CASE WHEN project_git_settings.repository_url=EXCLUDED.repository_url AND project_git_settings.default_branch IS NOT DISTINCT FROM EXCLUDED.default_branch
          THEN project_git_settings.sync_status ELSE 'not_synced' END,
        sync_error=CASE WHEN project_git_settings.repository_url=EXCLUDED.repository_url AND project_git_settings.default_branch IS NOT DISTINCT FROM EXCLUDED.default_branch
          THEN project_git_settings.sync_error ELSE NULL END,
        resolved_default_branch=CASE WHEN project_git_settings.repository_url=EXCLUDED.repository_url AND project_git_settings.default_branch IS NOT DISTINCT FROM EXCLUDED.default_branch
          THEN project_git_settings.resolved_default_branch ELSE NULL END,
        last_synced_at=CASE WHEN project_git_settings.repository_url=EXCLUDED.repository_url AND project_git_settings.default_branch IS NOT DISTINCT FROM EXCLUDED.default_branch
          THEN project_git_settings.last_synced_at ELSE NULL END,
        last_commit=CASE WHEN project_git_settings.repository_url=EXCLUDED.repository_url AND project_git_settings.default_branch IS NOT DISTINCT FROM EXCLUDED.default_branch
          THEN project_git_settings.last_commit ELSE NULL END,
        updated_by=EXCLUDED.updated_by, updated_at=NOW()
      RETURNING project_id, repository_url, default_branch, resolved_default_branch, sync_status, sync_error, last_synced_at::text, last_commit`,
    [args.projectId, repository.url, branch, args.userId])
    await client.query('COMMIT')
    return settings(rows[0])
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function clearProjectGitSettings(companyId: string, userId: string, projectId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, companyId, userId, projectId)
    await client.query('DELETE FROM project_git_settings WHERE project_id=$1', [projectId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

function mirrorPath(companyId: string, projectId: string): string {
  const key = createHash('sha256').update(`${companyId}\0${projectId}`).digest('hex')
  return join(resolve(env.PROJECT_GIT_ROOT), key.slice(0, 2), key, 'mirror.git')
}

async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: Array<{ address: string; family: number }>
  try { addresses = await lookup(hostname, { all: true, verbatim: true }) } catch { fail('GIT_HOST_UNAVAILABLE', 422, 'The Git host could not be resolved.') }
  if (!addresses.length || addresses.some(entry => isPrivateLiteral(entry.address))) fail('GIT_HOST_UNAVAILABLE', 422, 'The Git host resolves to a private or local address.')
}

async function runGit(args: string[], cwd: string | undefined, credential: { username: string; token: string; askpass: string; home: string }, timeout = 180_000) {
  return execFileP('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: credential.home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: credential.askpass,
    SSH_ASKPASS: credential.askpass, CUMORA_GIT_USERNAME: credential.username, CUMORA_GIT_TOKEN: credential.token,
    GIT_ALLOW_PROTOCOL: 'https', GIT_PROTOCOL_FROM_USER: '0', LANG: 'C.UTF-8',
  } })
}

function gitArgs(askpass: string, hooks: string): string[] {
  return ['-c', 'credential.helper=', '-c', `core.askPass=${askpass}`, '-c', 'http.followRedirects=false',
    '-c', 'protocol.file.allow=never', '-c', `core.hooksPath=${hooks}`]
}

function cleanGitError(error: unknown, token: string): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.split(token).join('[redacted]').split(resolve(env.PROJECT_GIT_ROOT)).join('<git-root>')
    .replace(/https:\/\/[^\s@/]+@/gu, 'https://').slice(0, 800)
}

async function syncNow(companyId: string, userId: string, projectId: string): Promise<ProjectGitSettings> {
  requireProjectGit()
  const client = await pool.connect()
  let row: SettingRow
  let credential: CredentialRow
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, companyId, userId, projectId)
    const selected = await client.query<SettingRow>('SELECT * FROM project_git_settings WHERE project_id=$1 FOR UPDATE', [projectId])
    if (!selected.rows[0]) fail('GIT_NOT_CONFIGURED', 409, 'Configure the project repository first.')
    row = selected.rows[0]
    const repository = normalizeRepositoryUrl(row.repository_url)
    const active = await client.query<CredentialRow>('SELECT * FROM company_git_credentials WHERE company_id=$1 AND active FOR SHARE', [companyId])
    if (!active.rows[0]) fail('GIT_CREDENTIAL_REQUIRED', 409, 'Activate a Git credential before syncing this project.')
    credential = active.rows[0]
    if (credential.host !== repository.host) fail('GIT_CREDENTIAL_HOST_MISMATCH', 409, `The active credential is for ${credential.host}, but this project uses ${repository.host}.`)
    await client.query("UPDATE project_git_settings SET sync_status='syncing', sync_error=NULL, updated_by=$2, updated_at=NOW() WHERE project_id=$1", [projectId, userId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }

  const token = openGitToken({ sealed: credential.token_encrypted, companyId, credentialId: credential.id, secret: env.GIT_CREDENTIAL_ENCRYPTION_SECRET })
  if (!token) {
    await pool.query("UPDATE project_git_settings SET sync_status='failed', sync_error='The active Git token cannot be decrypted. Replace it before syncing.', updated_at=NOW() WHERE project_id=$1", [projectId]).catch(() => {})
    fail('GIT_CREDENTIAL_UNAVAILABLE', 409, 'The active Git token cannot be decrypted. Replace it before syncing.')
  }
  const repository = normalizeRepositoryUrl(row.repository_url)
  const target = mirrorPath(companyId, projectId)
  const parent = resolve(target, '..')
  const temporaryRoot = join(resolve(env.PROJECT_GIT_ROOT), '.tmp')
  let stage = ''
  try {
    await assertPublicHost(new URL(repository.url).hostname)
    await Promise.all([mkdir(parent, { recursive: true, mode: 0o700 }), mkdir(temporaryRoot, { recursive: true, mode: 0o700 })])
    const temporary = await mkdtemp(join(temporaryRoot, 'sync-'))
    stage = join(temporary, 'mirror.git')
    const askpass = join(temporary, 'askpass.sh'), hooks = join(temporary, 'hooks'), gitHome = join(temporary, 'home')
    await Promise.all([mkdir(hooks, { mode: 0o700 }), mkdir(gitHome, { mode: 0o700 })])
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$CUMORA_GIT_USERNAME";; *Password*) printf "%s\\n" "$CUMORA_GIT_TOKEN";; *) exit 1;; esac\n', { mode: 0o700 })
    await chmod(askpass, 0o700)
    const auth = { username: credential.username, token, askpass, home: gitHome }
    await runGit([...gitArgs(askpass, hooks), 'clone', '--mirror', '--no-local', repository.url, stage], undefined, auth)
    let branch = normalizeBranch(row.default_branch)
    if (!branch) {
      const head = await runGit([...gitArgs(askpass, hooks), '--git-dir', stage, 'symbolic-ref', '--short', 'HEAD'], undefined, auth)
      branch = head.stdout.trim().replace(/^refs\/heads\//u, '')
    }
    if (!branch) fail('GIT_DEFAULT_BRANCH_MISSING', 422, 'The remote repository does not advertise a default branch. Configure one explicitly.')
    const commit = (await runGit([...gitArgs(askpass, hooks), '--git-dir', stage, 'rev-parse', `refs/heads/${branch}`], undefined, auth)).stdout.trim()
    const backup = `${target}.previous-${randomUUID()}`
    let hadTarget = false
    try { await access(target); hadTarget = true; await rename(target, backup) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try { await rename(stage, target) } catch (error) {
      if (hadTarget) await rename(backup, target).catch(() => {})
      throw error
    }
    if (hadTarget) await rm(backup, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
    const { rows } = await pool.query<SettingRow>(`UPDATE project_git_settings SET sync_status='ready', sync_error=NULL,
      resolved_default_branch=$3, last_synced_at=NOW(), last_commit=$4, updated_by=$2, updated_at=NOW()
      WHERE project_id=$1 AND repository_url=$5
      RETURNING project_id, repository_url, default_branch, resolved_default_branch, sync_status, sync_error, last_synced_at::text, last_commit`,
    [projectId, userId, branch, commit, repository.url])
    if (!rows[0]) fail('GIT_CONFIG_CHANGED', 409, 'The project Git configuration changed while it was syncing. Sync the new configuration.')
    return settings(rows[0])
  } catch (error) {
    const message = cleanGitError(error, token)
    await pool.query(`UPDATE project_git_settings SET sync_status='failed', sync_error=$2, updated_at=NOW()
      WHERE project_id=$1 AND repository_url=$3`, [projectId, message, repository.url]).catch(() => {})
    if (stage) await rm(resolve(stage, '..'), { recursive: true, force: true }).catch(() => {})
    if (error && typeof error === 'object' && 'status' in error) throw error
    fail('GIT_SYNC_FAILED', 422, `Git sync failed: ${message}`)
  }
}

export async function syncProjectGit(companyId: string, userId: string, projectId: string): Promise<ProjectGitSettings> {
  const previous = syncQueues.get(projectId) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => syncNow(companyId, userId, projectId))
  syncQueues.set(projectId, current)
  try { return await current } finally { if (syncQueues.get(projectId) === current) syncQueues.delete(projectId) }
}

export async function readyProjectGit(companyId: string, projectId: string): Promise<{
  repositoryUrl: string; defaultBranch: string; mirrorPath: string; commit: string
} | null> {
  if (!env.PROJECT_GIT_ENABLED || !env.PROJECT_GIT_ROOT) return null
  const { rows } = await pool.query<SettingRow>(`SELECT s.* FROM project_git_settings s JOIN projects p ON p.id=s.project_id
    WHERE s.project_id=$1 AND p.company_id=$2 AND s.sync_status='ready' AND s.resolved_default_branch IS NOT NULL AND s.last_commit IS NOT NULL`, [projectId, companyId])
  if (!rows[0]?.resolved_default_branch || !rows[0].last_commit) return null
  const path = mirrorPath(companyId, projectId)
  try { await access(path) } catch { return null }
  return { repositoryUrl: rows[0].repository_url, defaultBranch: rows[0].resolved_default_branch, mirrorPath: path, commit: rows[0].last_commit }
}
