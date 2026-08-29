import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessProjectFilesHost, findDataMount, type HostSnapshot } from '../project-files/preflight.js'

function host(): HostSnapshot {
  return {
    platform: 'linux', uid: 1000,
    fuse: { characterDevice: true, accessible: true, error: null },
    namespaces: { available: true, error: null },
    dataRoot: { path: '/data/projects', exists: true, directory: true, writable: true, availableBytes: 100_000_000_000, mount: { target: '/data', filesystem: 'ext4', readOnly: false } },
  }
}

test('preflight: a writable disk and working namespaces never imply production readiness', () => {
  const result = assessProjectFilesHost(host())
  assert.equal(result.prototypeEligible, true)
  assert.equal(result.productionReady, false)
  for (const id of ['persistent-storage', 'real-mount-behaviour', 'task-access-isolation', 'restart-recovery']) {
    assert.equal(result.checks.find(check => check.id === id)?.status, 'unverified', id)
  }
})

test('preflight: overlay and unknown mounts need provider evidence, not an automatic durability failure', () => {
  for (const mount of [null, { target: '/', filesystem: 'overlay', readOnly: false }]) {
    const snapshot = host()
    snapshot.dataRoot.mount = mount
    const result = assessProjectFilesHost(snapshot)
    assert.equal(result.prototypeEligible, true)
    assert.equal(result.productionReady, false)
    assert.equal(result.checks.find(check => check.id === 'persistent-storage')?.status, 'unverified')
  }
})

test('preflight: memory-backed or read-only mounts are unsuitable as durable data roots', () => {
  for (const mount of [{ target: '/data', filesystem: 'tmpfs', readOnly: false }, { target: '/data', filesystem: 'ramfs', readOnly: false }, { target: '/data', filesystem: 'ext4', readOnly: true }, { target: '/', filesystem: 'overlay', readOnly: true }]) {
    const snapshot = host()
    snapshot.dataRoot.mount = mount
    assert.equal(assessProjectFilesHost(snapshot).checks.find(check => check.id === 'persistent-storage')?.status, 'fail')
  }
})

test('preflight: unsupported host, unusable FUSE, missing isolation or missing directory fails the prototype gate', () => {
  const snapshots = [host(), host(), host(), host(), host(), host()]
  snapshots[0].platform = 'win32'
  snapshots[1].fuse.accessible = false
  snapshots[2].fuse.characterDevice = false
  snapshots[3].namespaces.available = false
  snapshots[4].dataRoot.exists = false
  snapshots[5].dataRoot.writable = false
  for (const snapshot of snapshots) assert.equal(assessProjectFilesHost(snapshot).prototypeEligible, false)
})

test('mount parsing chooses the most specific containing mount and omits raw host paths', () => {
  const mounts = [
    '10 1 0:1 / / rw,relatime - overlay overlay rw,lowerdir=/private-host-path',
    '11 10 8:1 / /data rw,relatime - ext4 /dev/secret-device rw',
    '12 11 8:2 / /data/shared\\040files ro,relatime - ext4 /dev/another-device rw',
  ].join('\n')
  assert.deepEqual(findDataMount(mounts, '/data/projects'), { target: '/data', filesystem: 'ext4', readOnly: false })
  assert.deepEqual(findDataMount(mounts, '/data/shared files/project'), { target: '/data/shared files', filesystem: 'ext4', readOnly: true })
  assert.equal(findDataMount(mounts, '/database/projects')?.target, '/')
  assert.equal(JSON.stringify(findDataMount(mounts, '/anything')).includes('private-host-path'), false)
  assert.equal(findDataMount('not mountinfo', '/data'), null)
})
