/**
 * Guard: no raw `child.stdin.write()` in the engine adapters.
 *
 * A failed pipe write — EPIPE, when the engine died or was killed mid-write —
 * is delivered ASYNCHRONOUSLY as an 'error' event on the stdin stream
 * (`afterWriteDispatched`, a tick later). The try/catch that used to wrap every
 * one of these writes had already returned by then and could not catch it, and
 * with no listener on the stream Node turns it into an uncaught exception.
 *
 * It surfaced as a flaky `write EPIPE` in PiAdapter.probeWake on CI — but every
 * adapter had the same hole, so this pins the whole file rather than that one
 * call site.
 *
 * Run: node --import tsx --test server/src/__tests__/engine-stdin-safety.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'computer', 'engine.ts')

/** Lines that write to a child's stdin directly, ignoring comments.
 *
 *  `writeStdin` itself is the one legitimate writer — it is the helper that
 *  attaches the listener first — so its body is excluded by slicing it out
 *  rather than by a broad pattern that could also hide a real offender. */
function rawStdinWrites(source: string): string[] {
  const start = source.indexOf('function writeStdin(')
  let body = source
  if (start >= 0) {
    const end = source.indexOf('\n}', start)
    body = source.slice(0, start) + (end >= 0 ? source.slice(end) : '')
  }
  return body.split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('//') && !l.startsWith('*'))
    .filter((l) => /stdin[?!]?\.write\s*\(/.test(l))
}

test('every engine stdin write goes through the safe helper', () => {
  const offenders = rawStdinWrites(readFileSync(ENGINE, 'utf8'))
  assert.deepEqual(
    offenders, [],
    '\nA raw stdin write cannot be protected by try/catch — EPIPE arrives a tick\n' +
    'later as a stream error and, unlistened, becomes an uncaught exception.\n' +
    'Use writeStdin() instead:\n' + offenders.map((l) => `  ${l}`).join('\n'),
  )
})

test('the matcher would catch a raw write', () => {
  // Keeps the guard above from silently becoming a no-op.
  assert.equal(rawStdinWrites('  child.stdin?.write("x")').length, 1)
  assert.equal(rawStdinWrites('  this.child.stdin!.write(msg)').length, 1)
  assert.equal(rawStdinWrites('  // child.stdin?.write("x") — explained in prose').length, 0)
})

test('an async stream write error escapes try/catch but not a listener', () => {
  // The mechanism itself, so the reason for the guard is executable and not
  // just an assertion in a comment.
  return new Promise<void>((resolve, reject) => {
    const stream = new PassThrough()
    let caughtByTryCatch = false
    let caughtByListener = false
    stream.on('error', () => { caughtByListener = true })
    try {
      stream.write('x')
      setImmediate(() => stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    } catch { caughtByTryCatch = true }
    setTimeout(() => {
      try {
        assert.equal(caughtByTryCatch, false, 'the try/catch cannot see an error delivered on a later tick')
        assert.equal(caughtByListener, true, 'only a stream listener sees it')
        resolve()
      } catch (e) { reject(e) }
    }, 50)
  })
})
