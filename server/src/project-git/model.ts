import { isIP } from 'node:net'
import { fail } from '../project-files/model.js'

export interface ProjectGitSettings {
  projectId: string
  repositoryUrl: string
  defaultBranch: string | null
  resolvedDefaultBranch: string | null
  syncStatus: 'not_synced' | 'syncing' | 'ready' | 'failed'
  syncError: string | null
  lastSyncedAt: string | null
  lastCommit: string | null
}

export function normalizeGitHost(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || raw.length > 255 || raw.includes('/') || raw.includes('@')) fail('INVALID_GIT_HOST', 400, 'Enter a Git host such as github.com.')
  let url: URL
  try { url = new URL(`https://${raw}`) } catch { fail('INVALID_GIT_HOST', 400, 'Enter a valid Git host.') }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('INVALID_GIT_HOST', 400, 'Enter only the Git host and optional port.')
  if (isPrivateLiteral(url.hostname)) fail('INVALID_GIT_HOST', 400, 'Private and local Git hosts are not supported by this deployment.')
  return url.host.toLowerCase()
}

export function normalizeRepositoryUrl(value: unknown): { url: string; host: string } {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > 2_000) fail('INVALID_GIT_URL', 400, 'An HTTPS Git repository URL is required.')
  let url: URL
  try { url = new URL(raw) } catch { fail('INVALID_GIT_URL', 400, 'Enter a valid HTTPS Git repository URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname || url.pathname === '/') {
    fail('INVALID_GIT_URL', 400, 'Use an HTTPS repository URL without credentials, query parameters or fragments.')
  }
  if (isPrivateLiteral(url.hostname)) fail('INVALID_GIT_URL', 400, 'Private and local Git hosts are not supported by this deployment.')
  return { url: url.toString(), host: url.host.toLowerCase() }
}

export function normalizeBranch(value: unknown): string | null {
  const branch = String(value ?? '').trim()
  if (!branch) return null
  if (branch.length > 240 || branch.startsWith('-') || branch.startsWith('.') || branch.endsWith('.') || branch.endsWith('/') ||
      branch.includes('..') || branch.includes('@{') || branch.includes('\\') || /[\x00-\x20~^:?*[\]]/u.test(branch) ||
      branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    fail('INVALID_GIT_BRANCH', 400, 'Enter a valid Git branch name.')
  }
  return branch
}

export function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const kind = isIP(host)
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224
  }
  if (kind === 6) return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/u.test(host)
  return false
}
