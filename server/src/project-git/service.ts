import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { requireProjectManager } from '../project-files/bindings.js'
import { fail } from '../project-files/model.js'
import { projectFilesFor, projectLeaseScope } from '../project-files/service.js'
import {
  isPrivateLiteral, normalizeBranch, normalizeRepositoryName, normalizeRepositoryUrl,
  type ProjectGitCredential, type ProjectGitRepository,
} from './model.js'
import { openGitToken, sealGitToken } from './token-vault.js'

const execFileP = promisify(execFile)
const queues = new Map<string, Promise<unknown>>()

interface RepositoryRow {
  id: string; project_id: string; company_id?: string; name: string; repository_url: string; host: string
  default_branch: string | null
  current_branch: string | null; sync_status: ProjectGitRepository['syncStatus']; sync_error: string | null
  last_synced_at: string | null; last_commit: string | null; root_entry_id: string | null
  created_at: string; updated_at: string
}

interface CredentialRow {
  project_id: string; username: string; token_encrypted: string; token_hint: string
  created_at: string; updated_at: string
}

const selectColumns = `r.id,r.project_id,r.name,r.repository_url,r.host,r.default_branch,r.current_branch,
  r.sync_status,r.sync_error,r.last_synced_at::text,r.last_commit,r.root_entry_id,
  r.created_at::text,r.updated_at::text`

function view(row: RepositoryRow, admin: boolean): ProjectGitRepository {
  return {
    id: row.id, projectId: row.project_id, name: row.name, repositoryUrl: row.repository_url, host: row.host,
    defaultBranch: row.default_branch,
    currentBranch: row.current_branch, syncStatus: row.sync_status, syncError: admin ? row.sync_error : null,
    lastSyncedAt: row.last_synced_at, lastCommit: row.last_commit, rootEntryId: row.root_entry_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function viewCredential(row: CredentialRow): ProjectGitCredential {
  return { projectId: row.project_id, username: row.username, tokenHint: row.token_hint,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

export function requireProjectGit(): void {
  if (!env.PROJECT_GIT_ENABLED || !env.PROJECT_GIT_ROOT) fail('PROJECT_GIT_DISABLED', 503, 'Project Git is not enabled on this host.')
  if (!isAbsolute(env.PROJECT_GIT_ROOT)) fail('PROJECT_GIT_DISABLED', 503, 'Project Git root must be an absolute path.')
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
function validateCommitMessage(value: unknown): string {
  const message = String(value ?? '').trim()
  if (!message || message.length > 4_000 || /\x00/u.test(message)) fail('INVALID_COMMIT_MESSAGE', 400, 'Enter a commit message of at most 4,000 characters.')
  return message
}
const tokenHint = (token: string) => `••••${[...token].slice(-4).join('')}`

async function projectRole(companyId: string, userId: string, projectId: string): Promise<{ admin: boolean }> {
  const { rows } = await pool.query<{ role: string }>(`SELECT cm.role FROM projects p JOIN company_members cm
    ON cm.company_id=p.company_id AND cm.user_id=$3 WHERE p.id=$1 AND p.company_id=$2 AND (
    EXISTS (SELECT 1 FROM conversations c WHERE c.project_id=p.id AND c.members @> jsonb_build_array($3::text))
    OR (NOT EXISTS (SELECT 1 FROM conversations c WHERE c.project_id=p.id) AND cm.role IN ('owner','admin')))`,
  [projectId, companyId, userId])
  if (!rows[0]) fail('NOT_FOUND', 404, 'Project not found.')
  return { admin: ['owner', 'admin'].includes(rows[0].role) }
}

export async function listProjectGitRepositories(companyId: string, userId: string, projectId: string): Promise<ProjectGitRepository[]> {
  const { admin } = await projectRole(companyId, userId, projectId)
  const { rows } = await pool.query<RepositoryRow>(`SELECT ${selectColumns} FROM project_git_repositories r
    JOIN projects p ON p.id=r.project_id WHERE r.project_id=$1 AND p.company_id=$2 ORDER BY r.created_at`, [projectId, companyId])
  return rows.map(row => view(row, admin))
}

export async function getProjectGitCredential(companyId: string, userId: string, projectId: string): Promise<ProjectGitCredential | null> {
  requireProjectGit()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, companyId, userId, projectId)
    const { rows } = await client.query<CredentialRow>(`SELECT project_id,username,token_encrypted,token_hint,
      created_at::text,updated_at::text FROM project_git_access WHERE project_id=$1`, [projectId])
    await client.query('COMMIT')
    return rows[0] ? viewCredential(rows[0]) : null
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function saveProjectGitCredential(args: {
  companyId: string; userId: string; projectId: string; username: unknown; token: unknown
}): Promise<ProjectGitCredential> {
  requireProjectGit()
  const username = validateUsername(args.username), token = validateToken(args.token)
  const encrypted = sealGitToken({ token, companyId: args.companyId, credentialId: args.projectId,
    secret: env.GIT_CREDENTIAL_ENCRYPTION_SECRET })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, args.companyId, args.userId, args.projectId)
    const { rows } = await client.query<CredentialRow>(`INSERT INTO project_git_access
      (project_id,username,token_encrypted,token_hint,updated_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (project_id) DO UPDATE SET username=EXCLUDED.username,token_encrypted=EXCLUDED.token_encrypted,
        token_hint=EXCLUDED.token_hint,updated_by=EXCLUDED.updated_by,updated_at=NOW()
      RETURNING project_id,username,token_encrypted,token_hint,created_at::text,updated_at::text`,
    [args.projectId, username, encrypted, tokenHint(token), args.userId])
    await client.query('COMMIT')
    return viewCredential(rows[0])
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function createProjectGitRepository(args: {
  companyId: string; userId: string; projectId: string; name: unknown; repositoryUrl: unknown
  defaultBranch?: unknown
}): Promise<ProjectGitRepository> {
  requireProjectGit()
  const id = `gitrepo-${randomUUID()}`, name = normalizeRepositoryName(args.name)
  const repository = normalizeRepositoryUrl(args.repositoryUrl), branch = normalizeBranch(args.defaultBranch)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, args.companyId, args.userId, args.projectId)
    const credential = await client.query('SELECT 1 FROM project_git_access WHERE project_id=$1', [args.projectId])
    if (!credential.rows[0]) fail('GIT_CREDENTIAL_REQUIRED', 409, 'Configure the project Git token before adding repositories.')
    const { rows } = await client.query<RepositoryRow>(`INSERT INTO project_git_repositories
      (id,project_id,name,repository_url,host,default_branch,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${selectColumns.replaceAll('r.', '')}`,
    [id, args.projectId, name, repository.url, repository.host, branch, args.userId])
    await client.query('COMMIT')
    return view(rows[0], true)
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23505') fail('GIT_NAME_EXISTS', 409, 'This project already has a repository with that name.')
    throw error
  } finally { client.release() }
}

export async function updateProjectGitRepository(args: {
  companyId: string; userId: string; projectId: string; repositoryId: string; name?: unknown
  repositoryUrl?: unknown; defaultBranch?: unknown
}): Promise<ProjectGitRepository> {
  requireProjectGit()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, args.companyId, args.userId, args.projectId)
    const selected = await client.query<RepositoryRow>('SELECT * FROM project_git_repositories WHERE id=$1 AND project_id=$2 FOR UPDATE', [args.repositoryId, args.projectId])
    const old = selected.rows[0]
    if (!old) fail('NOT_FOUND', 404, 'Git repository not found.')
    if (old.sync_status === 'syncing') fail('GIT_BUSY', 409, 'This repository is being cloned or removed. Try again later.')
    const name = args.name === undefined ? old.name : normalizeRepositoryName(args.name)
    const repository = args.repositoryUrl === undefined ? { url: old.repository_url, host: old.host } : normalizeRepositoryUrl(args.repositoryUrl)
    const branch = args.defaultBranch === undefined ? old.default_branch : normalizeBranch(args.defaultBranch)
    const changed = repository.url !== old.repository_url || branch !== old.default_branch
    if (old.sync_status === 'ready' && (name !== old.name || changed)) {
      fail('GIT_RECONFIGURE_UNSUPPORTED', 409, 'A cloned repository cannot be renamed or pointed at another URL or default branch. Remove it and add a new repository instead.')
    }
    const { rows } = await client.query<RepositoryRow>(`UPDATE project_git_repositories SET name=$3,repository_url=$4,host=$5,
      default_branch=$6,sync_status=CASE WHEN $7 THEN 'not_synced' ELSE sync_status END,
      sync_error=CASE WHEN $7 THEN NULL ELSE sync_error END,updated_by=$8,updated_at=NOW()
      WHERE id=$1 AND project_id=$2 RETURNING ${selectColumns.replaceAll('r.', '')}`,
    [old.id, args.projectId, name, repository.url, repository.host, branch, changed, args.userId])
    await client.query('COMMIT')
    return view(rows[0], true)
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23505') fail('GIT_NAME_EXISTS', 409, 'This project already has a repository with that name.')
    throw error
  } finally { client.release() }
}

function repositoryRoot(companyId: string, repositoryId: string): string {
  const key = createHash('sha256').update(`${companyId}\0${repositoryId}`).digest('hex')
  return join(resolve(env.PROJECT_GIT_ROOT), key.slice(0, 2), key)
}
const mirrorPath = (companyId: string, repositoryId: string) => join(repositoryRoot(companyId, repositoryId), 'mirror.git')

async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: Array<{ address: string }>
  try { addresses = await lookup(hostname, { all: true, verbatim: true }) } catch { fail('GIT_HOST_UNAVAILABLE', 422, 'The Git host could not be resolved.') }
  if (!addresses.length || addresses.some(entry => isPrivateLiteral(entry.address))) fail('GIT_HOST_UNAVAILABLE', 422, 'The Git host resolves to a private or local address.')
}

interface AuthContext { username: string; token: string; askpass: string; home: string; hooks: string }
function gitEnvironment(auth?: AuthContext): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: auth?.home ?? resolve(env.PROJECT_GIT_ROOT),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: auth?.askpass,
    SSH_ASKPASS: auth?.askpass, CUMORA_GIT_USERNAME: auth?.username, CUMORA_GIT_TOKEN: auth?.token,
    GIT_ALLOW_PROTOCOL: auth ? 'https' : 'file', GIT_PROTOCOL_FROM_USER: '0', LANG: 'C.UTF-8',
  }
}
async function runGit(args: string[], cwd?: string, auth?: AuthContext, timeout = 180_000) {
  const hardening = ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.ext.allow=never',
    '-c', `core.hooksPath=${auth?.hooks ?? '/dev/null'}`]
  return execFileP('git', [...hardening, ...args], { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: gitEnvironment(auth) })
}
function cleanGitError(error: unknown, token = ''): string {
  let value = error instanceof Error ? error.message : String(error)
  if (token) value = value.split(token).join('[redacted]')
  return value.split(resolve(env.PROJECT_GIT_ROOT)).join('<git-root>').replace(/https:\/\/[^\s@/]+@/gu, 'https://').slice(0, 800)
}
async function authContext(root: string, row: CredentialRow, companyId: string): Promise<AuthContext & { cleanup: () => Promise<void> }> {
  const token = openGitToken({ sealed: row.token_encrypted, companyId, credentialId: row.project_id, secret: env.GIT_CREDENTIAL_ENCRYPTION_SECRET })
  if (!token) fail('GIT_CREDENTIAL_UNAVAILABLE', 409, 'This repository token cannot be decrypted. Replace it before cloning.')
  const directory = await mkdtemp(join(root, 'auth-'))
  const askpass = join(directory, 'askpass.sh'), home = join(directory, 'home'), hooks = join(directory, 'hooks')
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(hooks, { mode: 0o700 })])
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$CUMORA_GIT_USERNAME";; *Password*) printf "%s\\n" "$CUMORA_GIT_TOKEN";; *) exit 1;; esac\n', { mode: 0o700 })
  await chmod(askpass, 0o700)
  return { username: row.username, token, askpass, home, hooks, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

async function scanWorktree(worktree: string): Promise<Array<{ path: string; content: Buffer }>> {
  const { stdout } = await runGit(['-C', worktree, 'ls-files', '--stage', '-z'])
  const files: Array<{ path: string; content: Buffer }> = []
  for (const record of stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/u.exec(record)
    if (!match) fail('INVALID_GIT_TREE', 422, 'The repository index contains an invalid entry.')
    if (match[1] === '120000' || match[1] === '160000') fail('UNSUPPORTED_GIT_ENTRY', 422, 'Symbolic links and submodules are not supported in project repositories.')
    const path = match[2]
    const absolute = resolve(worktree, ...path.split('/'))
    if (!absolute.startsWith(`${resolve(worktree)}${process.platform === 'win32' ? '\\' : '/'}`)) fail('INVALID_GIT_TREE', 422, 'The repository contains an invalid path.')
    const info = await lstat(absolute)
    if (!info.isFile()) fail('UNSUPPORTED_GIT_ENTRY', 422, 'Only regular files are supported in project repositories.')
    files.push({ path, content: await readFile(absolute) })
  }
  return files
}

async function loadRow(companyId: string, projectId: string, repositoryId: string, lock = false): Promise<RepositoryRow> {
  const { rows } = await pool.query<RepositoryRow>(`SELECT ${selectColumns},p.company_id FROM project_git_repositories r
    JOIN projects p ON p.id=r.project_id WHERE r.id=$1 AND r.project_id=$2 AND p.company_id=$3${lock ? ' FOR UPDATE OF r' : ''}`,
  [repositoryId, projectId, companyId])
  if (!rows[0]) fail('NOT_FOUND', 404, 'Git repository not found.')
  return rows[0]
}

async function cloneNow(companyId: string, userId: string, projectId: string, repositoryId: string): Promise<ProjectGitRepository> {
  requireProjectGit()
  const client = await pool.connect()
  let row: RepositoryRow, credential: CredentialRow
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, companyId, userId, projectId)
    const selected = await client.query<RepositoryRow>('SELECT * FROM project_git_repositories WHERE id=$1 AND project_id=$2 FOR UPDATE', [repositoryId, projectId])
    if (!selected.rows[0]) fail('NOT_FOUND', 404, 'Git repository not found.')
    row = selected.rows[0]
    if (row.sync_status === 'ready') fail('GIT_ALREADY_CLONED', 409, 'This repository is already cloned. Branch changes and commits must be performed by an Agent; remote refresh is not enabled yet.')
    if (row.sync_status === 'syncing') fail('GIT_BUSY', 409, 'This repository is already being cloned or removed.')
    const access = await client.query<CredentialRow>('SELECT * FROM project_git_access WHERE project_id=$1', [projectId])
    if (!access.rows[0]) fail('GIT_CREDENTIAL_REQUIRED', 409, 'Configure the project Git token before cloning repositories.')
    credential = access.rows[0]
    await client.query("UPDATE project_git_repositories SET sync_status='syncing',sync_error=NULL,updated_by=$2,updated_at=NOW() WHERE id=$1", [repositoryId, userId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }

  const temporaryRoot = join(resolve(env.PROJECT_GIT_ROOT), '.tmp')
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  const operation = await mkdtemp(join(temporaryRoot, 'clone-'))
  let auth: Awaited<ReturnType<typeof authContext>> | null = null
  try {
    await assertPublicHost(new URL(row.repository_url).hostname)
    auth = await authContext(operation, credential, companyId)
    const mirror = join(operation, 'mirror.git'), worktree = join(operation, 'worktree')
    await runGit(['clone', '--mirror', '--no-local', row.repository_url, mirror], undefined, auth)
    let branch = normalizeBranch(row.default_branch)
    if (!branch) branch = (await runGit(['--git-dir', mirror, 'symbolic-ref', '--short', 'HEAD'], undefined, auth)).stdout.trim().replace(/^refs\/heads\//u, '')
    if (!branch) fail('GIT_DEFAULT_BRANCH_MISSING', 422, 'The remote repository does not advertise a default branch.')
    await runGit(['-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', mirror, worktree])
    await runGit(['-C', worktree, 'switch', branch])
    const commit = (await runGit(['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
    const files = await scanWorktree(worktree)
    const imported = await projectFilesFor({ kind: 'system', companyId, projectId }).importGitTree(projectId, repositoryId, row.name, files)
    const target = repositoryRoot(companyId, repositoryId)
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { mode: 0o700 })
    await rename(mirror, join(target, 'mirror.git'))
    const { rows } = await pool.query<RepositoryRow>(`UPDATE project_git_repositories SET current_branch=$2,sync_status='ready',
      sync_error=NULL,last_synced_at=NOW(),last_commit=$3,root_entry_id=$4,updated_at=NOW()
      WHERE id=$1 AND project_id=$5 RETURNING ${selectColumns.replaceAll('r.', '')}`,
    [repositoryId, branch, commit, imported.rootEntryId, projectId])
    return view(rows[0], true)
  } catch (error) {
    const message = cleanGitError(error, auth?.token)
    await pool.query("UPDATE project_git_repositories SET sync_status='failed',sync_error=$2,updated_at=NOW() WHERE id=$1", [repositoryId, message]).catch(() => {})
    if (error && typeof error === 'object' && 'status' in error) throw error
    fail('GIT_SYNC_FAILED', 422, `Git clone failed: ${message}`)
  } finally {
    await auth?.cleanup().catch(() => {})
    await rm(operation, { recursive: true, force: true }).catch(() => {})
  }
  throw new Error('unreachable')
}

function queued<T>(repositoryId: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(repositoryId) ?? Promise.resolve()
  const current = prior.catch(() => {}).then(work)
  queues.set(repositoryId, current)
  return current.finally(() => { if (queues.get(repositoryId) === current) queues.delete(repositoryId) })
}
export const syncProjectGitRepository = (companyId: string, userId: string, projectId: string, repositoryId: string) =>
  queued(repositoryId, () => cloneNow(companyId, userId, projectId, repositoryId))

async function deleteNow(companyId: string, userId: string, projectId: string, repositoryId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireProjectManager(client, companyId, userId, projectId)
    const active = await client.query('SELECT 1 FROM project_file_leases WHERE project_id=$1 AND revoked_at IS NULL AND stopped_at IS NULL AND expires_at>NOW() LIMIT 1', [projectId])
    if (active.rows[0]) fail('REPOSITORY_BUSY', 409, 'Finish active Agent project tasks before removing a repository.')
    const selected = await client.query('SELECT 1 FROM project_git_repositories WHERE id=$1 AND project_id=$2 FOR UPDATE', [repositoryId, projectId])
    if (!selected.rowCount) fail('NOT_FOUND', 404, 'Git repository not found.')
    await client.query("UPDATE project_git_repositories SET sync_status='syncing',sync_error='Repository removal in progress.',updated_by=$2,updated_at=NOW() WHERE id=$1", [repositoryId, userId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  await projectFilesFor({ kind: 'system', companyId, projectId }).removeGitTree(projectId, repositoryId)
  const deleted = await pool.query('DELETE FROM project_git_repositories WHERE id=$1 AND project_id=$2', [repositoryId, projectId])
  if (!deleted.rowCount) fail('NOT_FOUND', 404, 'Git repository not found.')
  await rm(repositoryRoot(companyId, repositoryId), { recursive: true, force: true }).catch(() => {})
}

export const deleteProjectGitRepository = (companyId: string, userId: string, projectId: string, repositoryId: string) =>
  queued(repositoryId, () => deleteNow(companyId, userId, projectId, repositoryId))

async function requireExclusiveLease(token: string, repositoryId: string) {
  const lease = await projectLeaseScope(token)
  const row = await loadRow(lease.company_id, lease.project_id, repositoryId)
  const { rows } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int count FROM project_file_leases
    WHERE project_id=$1 AND id<>$2 AND revoked_at IS NULL AND stopped_at IS NULL AND expires_at>NOW()`, [lease.project_id, lease.id])
  if (rows[0].count) fail('REPOSITORY_BUSY', 409, 'Another Agent task is using this project. Finish it before changing branch or committing.')
  return { lease, row }
}

async function freezeProject(projectId: string, value: boolean): Promise<void> {
  await pool.query('UPDATE projects SET file_switching=$2 WHERE id=$1', [projectId, value])
}

async function materialize(mirror: string, branch: string, root: string): Promise<string> {
  const worktree = join(root, 'worktree')
  await runGit(['-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', mirror, worktree])
  await runGit(['-C', worktree, 'switch', branch])
  return worktree
}

export async function projectGitStatus(token: string, repositoryId: string) {
  const lease = await projectLeaseScope(token)
  const row = await loadRow(lease.company_id, lease.project_id, repositoryId)
  const snapshot = await projectFilesFor({ kind: 'lease', token }).exportGitTree(lease.project_id, row.id)
  return { repositoryId: row.id, name: row.name, branch: row.current_branch, commit: row.last_commit, dirty: snapshot.dirty }
}

export async function listAgentProjectGit(token: string) {
  const lease = await projectLeaseScope(token)
  const { rows } = await pool.query<RepositoryRow>(`SELECT ${selectColumns} FROM project_git_repositories r
    WHERE r.project_id=$1 ORDER BY r.created_at`, [lease.project_id])
  return rows.map(row => ({ id: row.id, name: row.name, branch: row.current_branch, commit: row.last_commit,
    ready: row.sync_status === 'ready', path: `/projects/${lease.project_id}/Repositories/${row.name}` }))
}

export async function switchProjectGitBranch(token: string, repositoryId: string, value: unknown) {
  const branch = normalizeBranch(value)
  if (!branch) fail('INVALID_GIT_BRANCH', 400, 'A branch is required.')
  return queued(repositoryId, async () => {
    const { lease, row } = await requireExclusiveLease(token, repositoryId)
    if (row.sync_status !== 'ready' || !row.current_branch) fail('GIT_NOT_SYNCED', 409, 'Clone this repository before switching branches.')
    await freezeProject(lease.project_id, true)
    let root = ''
    try {
      const temporary = join(resolve(env.PROJECT_GIT_ROOT), '.tmp'); await mkdir(temporary, { recursive: true, mode: 0o700 })
      root = await mkdtemp(join(temporary, 'switch-'))
      const current = await projectFilesFor({ kind: 'lease', token }).exportGitTree(lease.project_id, row.id)
      if (current.dirty) fail('GIT_DIRTY', 409, 'Commit the current repository changes before switching branches.')
      const mirror = mirrorPath(lease.company_id, row.id)
      await access(mirror)
      await runGit(['--git-dir', mirror, 'check-ref-format', '--branch', branch])
      await runGit(['--git-dir', mirror, 'rev-parse', '--verify', `refs/heads/${branch}`])
      const worktree = await materialize(mirror, branch, root)
      const commit = (await runGit(['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
      const imported = await projectFilesFor({ kind: 'system', companyId: lease.company_id, projectId: lease.project_id })
        .importGitTree(lease.project_id, row.id, row.name, await scanWorktree(worktree))
      await pool.query(`UPDATE project_git_repositories SET current_branch=$2,last_commit=$3,root_entry_id=$4,updated_at=NOW()
        WHERE id=$1 AND project_id=$5`, [row.id, branch, commit, imported.rootEntryId, lease.project_id])
      return { repositoryId: row.id, branch, commit }
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
      await freezeProject(lease.project_id, false).catch(() => {})
    }
  })
}

export async function commitProjectGit(token: string, repositoryId: string, messageValue: unknown) {
  const message = validateCommitMessage(messageValue)
  return queued(repositoryId, async () => {
    const { lease, row } = await requireExclusiveLease(token, repositoryId)
    if (row.sync_status !== 'ready' || !row.current_branch) fail('GIT_NOT_SYNCED', 409, 'Clone this repository before committing.')
    await freezeProject(lease.project_id, true)
    const { rows: agents } = await pool.query<{ name: string }>('SELECT name FROM participants WHERE id=$1 AND company_id=$2', [lease.agent_id, lease.company_id])
    const author = agents[0]?.name || 'Cumora Agent'
    let root = ''
    try {
      const temporary = join(resolve(env.PROJECT_GIT_ROOT), '.tmp'); await mkdir(temporary, { recursive: true, mode: 0o700 })
      root = await mkdtemp(join(temporary, 'commit-'))
      const snapshot = await projectFilesFor({ kind: 'lease', token }).exportGitTree(lease.project_id, row.id)
      if (!snapshot.dirty) fail('GIT_CLEAN', 409, 'There are no repository changes to commit.')
      const mirror = mirrorPath(lease.company_id, row.id), worktree = await materialize(mirror, row.current_branch, root)
      for (const item of await readdir(worktree, { withFileTypes: true })) if (item.name !== '.git') {
        await rm(join(worktree, item.name), { recursive: true, force: true })
      }
      for (const file of snapshot.files) {
        const target = resolve(worktree, ...file.path.split('/'))
        if (!target.startsWith(`${resolve(worktree)}${process.platform === 'win32' ? '\\' : '/'}`)) fail('INVALID_GIT_TREE', 422, 'Invalid repository path.')
        await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
        await writeFile(target, file.content, { mode: 0o600 })
      }
      await runGit(['-C', worktree, 'add', '--all'])
      await runGit(['-C', worktree, '-c', `user.name=${author}`, '-c', `user.email=${lease.agent_id}@agents.cumora.local`, 'commit', '-m', message])
      const commit = (await runGit(['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
      await runGit(['--git-dir', mirror, '-c', 'protocol.file.allow=always', 'fetch', worktree, commit])
      await runGit(['--git-dir', mirror, 'update-ref', `refs/heads/${row.current_branch}`, commit,
        ...(row.last_commit ? [row.last_commit] : [])])
      await projectFilesFor({ kind: 'system', companyId: lease.company_id, projectId: lease.project_id }).markGitCommitted(lease.project_id, row.id)
      await pool.query('UPDATE project_git_repositories SET last_commit=$2,updated_at=NOW() WHERE id=$1', [row.id, commit])
      return { repositoryId: row.id, branch: row.current_branch, commit }
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
      await freezeProject(lease.project_id, false).catch(() => {})
    }
  })
}
