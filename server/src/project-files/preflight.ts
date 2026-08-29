import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, posix } from 'node:path'

export interface MountSummary {
  target: string
  filesystem: string
  readOnly: boolean
}

export interface HostSnapshot {
  platform: string
  uid: number | null
  fuse: { characterDevice: boolean; accessible: boolean; error: string | null }
  namespaces: { available: boolean; error: string | null }
  dataRoot: { path: string; exists: boolean; directory: boolean; writable: boolean; mount: MountSummary | null; availableBytes: number | null }
}

export interface PreflightCheck {
  id: string
  status: 'pass' | 'fail' | 'unverified'
  detail: string
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

/** Keep only mount type/path/readonly state; never expose host backing paths. */
export function findDataMount(mountInfo: string, dataRoot: string): MountSummary | null {
  let best: MountSummary | null = null
  for (const line of mountInfo.split('\n')) {
    const separator = line.indexOf(' - ')
    if (separator < 0) continue
    const left = line.slice(0, separator).split(' ')
    const right = line.slice(separator + 3).split(' ')
    if (left.length < 6 || right.length < 3) continue
    const target = decodeMountPath(left[4])
    const relative = posix.relative(target, dataRoot)
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) continue
    if (best && best.target.length >= target.length) continue
    best = { target, filesystem: right[0], readOnly: left[5].split(',').includes('ro') || right[2].split(',').includes('ro') }
  }
  return best
}

export function assessProjectFilesHost(snapshot: HostSnapshot): {
  prototypeEligible: boolean
  productionReady: false
  checks: PreflightCheck[]
} {
  const checks: PreflightCheck[] = [
    { id: 'linux', status: snapshot.platform === 'linux' ? 'pass' : 'fail', detail: 'The first implementation requires Linux.' },
    { id: 'fuse-device', status: snapshot.fuse.characterDevice && snapshot.fuse.accessible ? 'pass' : 'fail', detail: snapshot.fuse.error ?? '/dev/fuse is a character device and can be opened.' },
    { id: 'task-namespaces', status: snapshot.namespaces.available ? 'pass' : 'fail', detail: snapshot.namespaces.error ?? 'Unprivileged user, mount and PID namespace creation succeeded.' },
    { id: 'data-directory', status: snapshot.dataRoot.exists && snapshot.dataRoot.directory && snapshot.dataRoot.writable ? 'pass' : 'fail', detail: 'The selected data root must be an existing writable directory.' },
  ]
  const mount = snapshot.dataRoot.mount
  const memoryBacked = mount && ['tmpfs', 'ramfs'].includes(mount.filesystem)
  checks.push({
    id: 'persistent-storage',
    status: mount && (memoryBacked || mount.readOnly) ? 'fail' : 'unverified',
    detail: !mount ? 'The backing mount could not be identified; persistence is unverified, not disproven.'
      : mount.readOnly ? 'The selected mount is read-only.'
      : memoryBacked ? `The selected directory is on ${mount.filesystem}; volatile memory is not a durable data root.`
      : mount.filesystem === 'overlay' ? 'Overlay alone does not establish or disprove persistence; verify the provider\'s retained paths and recovery policy.'
      : 'A writable disk mount was found; the operator must still confirm retention and complete a recovery drill.',
  })
  checks.push(
    { id: 'real-mount-behaviour', status: 'unverified', detail: 'Opening /dev/fuse is not a mount or filesystem correctness test.' },
    { id: 'task-access-isolation', status: 'unverified', detail: 'Namespaces alone do not hide the backing store or revoke open handles; test the actual runner.' },
    { id: 'restart-recovery', status: 'unverified', detail: 'Verify service supervision, durable commits, backup and restore before enabling the feature.' },
  )
  return { prototypeEligible: checks.slice(0, 4).every(check => check.status === 'pass'), productionReady: false, checks }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNAVAILABLE'
}

/** Read-only host inspection. No sudo, package install, mount, mkdir, DB or env loading. */
export function inspectProjectFilesHost(dataRoot: string): HostSnapshot {
  const root = resolve(dataRoot)
  const snapshot: HostSnapshot = {
    platform: process.platform,
    uid: process.getuid?.() ?? null,
    fuse: { characterDevice: false, accessible: false, error: null },
    namespaces: { available: false, error: null },
    dataRoot: { path: root, exists: existsSync(root), directory: false, writable: false, mount: null, availableBytes: null },
  }
  try {
    snapshot.dataRoot.directory = statSync(root).isDirectory()
    accessSync(root, constants.W_OK)
    snapshot.dataRoot.writable = true
    const disk = statfsSync(root, { bigint: true })
    const available = disk.bavail * disk.bsize
    snapshot.dataRoot.availableBytes = available <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(available) : null
  } catch { /* reported by data-directory; do not create it during a probe */ }
  if (process.platform !== 'linux') {
    snapshot.fuse.error = 'Linux required'
    snapshot.namespaces.error = 'Linux required'
    return snapshot
  }
  try {
    snapshot.fuse.characterDevice = statSync('/dev/fuse').isCharacterDevice()
    if (snapshot.fuse.characterDevice) {
      const fd = openSync('/dev/fuse', constants.O_RDWR)
      try { snapshot.fuse.accessible = true } finally { closeSync(fd) }
    } else snapshot.fuse.error = '/dev/fuse is not a character device'
  } catch (error) { snapshot.fuse.error = errorCode(error) }
  const probe = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child', '/bin/true'], {
    timeout: 5000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  snapshot.namespaces.available = !probe.error && probe.status === 0
  if (!snapshot.namespaces.available) snapshot.namespaces.error = probe.error ? errorCode(probe.error) : `unshare exited ${probe.status ?? probe.signal}`
  try { snapshot.dataRoot.mount = findDataMount(readFileSync('/proc/self/mountinfo', 'utf8'), root) } catch { /* unverified */ }
  return snapshot
}
