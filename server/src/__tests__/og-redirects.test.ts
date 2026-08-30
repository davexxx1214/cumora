/**
 * Open Graph SSRF and redirect regression tests.
 *
 * Run: node --import tsx --test server/src/__tests__/og-redirects.test.ts
 */
import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, test } from 'node:test'

// Keep Redis lazy during this focused unit test. ogPreview's cache methods are
// stubbed below, so no external service is required.
process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { OgError, ogPreview, __setOgFetchDependenciesForTesting } = await import('../og.js')
const { redis, sub } = await import('../redis.js')

type Dependencies = Exclude<Parameters<typeof __setOgFetchDependenciesForTesting>[0], null>
type RequestTarget = Parameters<Dependencies['request']>[0]
type OgResponse = Awaited<ReturnType<Dependencies['request']>>

const savedWarn = console.warn
const savedRedisGet = redis.get.bind(redis)
const savedRedisSet = redis.set.bind(redis)

function response(
  status: number,
  headers: Record<string, string> = {},
  chunks: Array<string | Buffer> = [],
  onCancel?: () => void,
): OgResponse {
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk)
    })(),
    cancel: () => onCancel?.(),
  }
}

beforeEach(() => {
  ;(redis as unknown as { get: (key: string) => Promise<string | null> }).get = async () => null
  ;(redis as unknown as { set: (key: string, value: string) => Promise<'OK'> }).set =
    async () => 'OK'
  console.warn = () => { /* expected fetch failures stay quiet in tests */ }
})

afterEach(() => {
  __setOgFetchDependenciesForTesting(null)
  console.warn = savedWarn
  ;(redis as unknown as { get: typeof savedRedisGet }).get = savedRedisGet
  ;(redis as unknown as { set: typeof savedRedisSet }).set = savedRedisSet
})

after(() => {
  redis.disconnect()
  sub.disconnect()
})

test('ogPreview pins the connection to the exact public DNS answer it validated', async () => {
  let lookupCalls = 0
  const connected: Array<Pick<RequestTarget, 'hostname' | 'address' | 'family'>> = []
  __setOgFetchDependenciesForTesting({
    lookup: async hostname => {
      assert.equal(hostname, 'rebind.example')
      lookupCalls += 1
      // A second resolution would simulate a rebound private answer. The
      // request layer must receive the first address directly instead.
      return lookupCalls === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }]
    },
    request: async target => {
      connected.push({ hostname: target.hostname, address: target.address, family: target.family })
      return response(200, { 'content-type': 'text/html' }, [
        '<html><head><title>Pinned article</title></head></html>',
      ])
    },
  })

  const result = await ogPreview('https://rebind.example/article')

  assert.equal(result?.title, 'Pinned article')
  assert.equal(lookupCalls, 1)
  assert.deepEqual(connected, [
    { hostname: 'rebind.example', address: '93.184.216.34', family: 4 },
  ])
})

test('ogPreview rejects a hostname when any DNS answer is private', async () => {
  let requests = 0
  __setOgFetchDependenciesForTesting({
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ],
    request: async () => {
      requests += 1
      return response(500)
    },
  })

  await assert.rejects(
    () => ogPreview('https://mixed.example/article'),
    (error: unknown) => error instanceof OgError && error.status === 403,
  )
  assert.equal(requests, 0)
})

test('ogPreview revalidates and pins every public redirect hop', async () => {
  const lookedUp: string[] = []
  const connected: Array<Pick<RequestTarget, 'hostname' | 'address'>> = []
  let cancelled = 0
  __setOgFetchDependenciesForTesting({
    lookup: async hostname => {
      lookedUp.push(hostname)
      return hostname === 'start.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '1.1.1.1', family: 4 }]
    },
    request: async target => {
      connected.push({ hostname: target.hostname, address: target.address })
      if (target.hostname === 'start.example') {
        return response(302, { location: 'https://cdn.example/article' }, [], () => { cancelled += 1 })
      }
      return response(200, { 'content-type': 'text/html' }, [
        '<html><head><title>Public article</title></head></html>',
      ])
    },
  })

  const result = await ogPreview('https://start.example/short')

  assert.equal(result?.title, 'Public article')
  assert.equal(result?.finalUrl, 'https://cdn.example/article')
  assert.deepEqual(lookedUp, ['start.example', 'cdn.example'])
  assert.deepEqual(connected, [
    { hostname: 'start.example', address: '93.184.216.34' },
    { hostname: 'cdn.example', address: '1.1.1.1' },
  ])
  assert.equal(cancelled, 1)
})

test('ogPreview rejects a redirect to cloud metadata before the second request', async () => {
  const connected: string[] = []
  __setOgFetchDependenciesForTesting({
    lookup: async hostname => hostname === 'start.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }],
    request: async target => {
      connected.push(target.address)
      return response(302, { location: 'http://metadata.internal/latest' })
    },
  })

  await assert.rejects(
    () => ogPreview('https://start.example/redirect-private'),
    (error: unknown) => error instanceof OgError && error.status === 403,
  )
  assert.deepEqual(connected, ['93.184.216.34'])
})

test('ogPreview blocks alternate private IP literals before DNS or connect', async () => {
  for (const url of [
    'http://127.0.0.1/article',
    'http://2130706433/article',
    'http://[::1]/article',
    'http://[::ffff:7f00:1]/article',
    'http://[64:ff9b::7f00:1]/article',
  ]) {
    let lookups = 0
    let requests = 0
    __setOgFetchDependenciesForTesting({
      lookup: async () => { lookups += 1; return [] },
      request: async () => { requests += 1; return response(500) },
    })

    await assert.rejects(
      () => ogPreview(url),
      (error: unknown) => error instanceof OgError && error.status === 403,
      url,
    )
    assert.equal(lookups, 0, url)
    assert.equal(requests, 0, url)
  }
})

test('ogPreview rejects a redirect to a non-http protocol', async () => {
  let requests = 0
  __setOgFetchDependenciesForTesting({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => {
      requests += 1
      return response(302, { location: 'file:///etc/passwd' })
    },
  })

  await assert.rejects(
    () => ogPreview('https://start.example/redirect-file'),
    (error: unknown) => error instanceof OgError && error.status === 400,
  )
  assert.equal(requests, 1)
})

test('ogPreview stops after the bounded redirect limit', async () => {
  let requests = 0
  let cancelled = 0
  __setOgFetchDependenciesForTesting({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => {
      requests += 1
      return response(302, { location: `/loop/${requests}` }, [], () => { cancelled += 1 })
    },
  })

  const result = await ogPreview('https://loop.example/loop/0')

  assert.equal(result, null)
  assert.equal(requests, 6)
  assert.equal(cancelled, 6)
})
