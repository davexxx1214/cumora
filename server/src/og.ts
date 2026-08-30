/**
 * Open-Graph / link-preview fetcher.
 *
 * Frontend chat bubbles call `/api/og?url=…` when they detect an autolinked
 * URL, so they can render a card with the page's title / description /
 * hero image (the same affordance Slack and iMessage show). This module
 * owns the network fetch, the metadata parser, and the Redis cache.
 *
 *   request flow:
 *     1. validate the URL (scheme, hostname, DNS-resolved IP) — no SSRF
 *     2. consult Redis (cumora:og:<url>) — 7d positive TTL, 1h negative
 *     3. fetch the HTML body, size- and time-bounded
 *     4. extract og:* / twitter:* / <title> / meta description
 *     5. cache + return
 *
 * Cache miss latency dominates; cache hits are sub-ms. The cache key is the
 * raw input URL so the same string from two messages reuses the same entry.
 */
import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { redis } from './redis.js'

const CACHE_PREFIX = 'cumora:og:'
/** Positive cache: how long a successful fetch stays valid. 7 days is long
 *  enough that hot URLs stay cached across a typical workweek, short enough
 *  that a site re-launch or article edit gets picked up within reasonable
 *  time. */
const POSITIVE_TTL_S = 7 * 24 * 3600
/** Negative cache: failed fetches (404, blocked host, parse error) get a
 *  shorter TTL so transient outages recover faster, but long enough that
 *  the same broken link in 1000 messages doesn't refire 1000 network
 *  requests in a tight loop. */
const NEGATIVE_TTL_S = 60 * 60

const FETCH_TIMEOUT_MS = 6000
/** Match fetch's bounded redirect behaviour while keeping each hop under our
 *  own destination policy. Five hops covers common short-link chains without
 *  allowing an attacker to keep the server in an unbounded redirect loop. */
const MAX_REDIRECTS = 5
/** Cap response size to keep memory bounded — OG meta lives in `<head>`,
 *  so 1 MB is plenty for any sane page. Streamed reader aborts early once
 *  this threshold is crossed. */
const MAX_BYTES = 1024 * 1024

interface ResolvedAddress {
  address: string
  family: 4 | 6
}

interface ResolvedOgTarget {
  url: URL
  hostname: string
  address: string
  family: 4 | 6
}

interface OgHttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: AsyncIterable<Uint8Array>
  cancel(): void
}

interface OgFetchDependencies {
  lookup(hostname: string): Promise<readonly ResolvedAddress[]>
  request(target: ResolvedOgTarget, signal: AbortSignal): Promise<OgHttpResponse>
}

const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4')
}

const blockedIpv6 = new BlockList()
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6')
}

export interface OgResult {
  url: string
  title?: string
  description?: string
  image?: string
  siteName?: string
  /** Final URL after redirects — useful when the input was a redirect-y
   *  short link (t.co, lnk.to) and the renderer wants to display the real
   *  hostname under the title. */
  finalUrl?: string
}

export class OgError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** URL-policy failures must reach the route as 4xx responses even when they
 *  are discovered on a redirect hop. Network/content failures remain a
 *  negative preview result and retain the existing short cache behaviour. */
class OgUrlError extends OgError {}

/** Fetch + parse OG metadata for a URL. Returns null when there's nothing
 *  useful to display (no title / og:title fallback path produced anything),
 *  so callers can skip rendering an empty card. Throws `OgError` for
 *  rejected URLs (bad scheme, SSRF host) so the route handler can map them
 *  to a 4xx instead of leaking 500s. */
export async function ogPreview(rawUrl: string): Promise<OgResult | null> {
  const url = validateUrlString(rawUrl)
  const cacheKey = `${CACHE_PREFIX}${url}`

  // Cache hit (positive or negative). Negative entries serialize as the
  // string "null" so we can distinguish "looked up + nothing useful" from
  // "never looked up" without a separate flag.
  const cached = await redis.get(cacheKey)
  if (cached !== null) {
    if (cached === 'null') return null
    try { return JSON.parse(cached) as OgResult } catch { /* corrupt entry, refetch */ }
  }

  let result: OgResult | null = null
  try {
    result = await fetchAndParse(url, ogFetchDependenciesOverride ?? productionDependencies)
  } catch (e) {
    if (e instanceof OgUrlError) throw e
    // Network or parse failure — cache the miss briefly so we don't hammer
    // the upstream. Real protocol errors (bad host, scheme) already threw
    // before this point or were rethrown above for a redirect target.
    console.warn(`[og] fetch failed for ${url}:`, e instanceof Error ? e.message : e)
    result = null
  }

  // Discard cards that have no usable display data (no title and no image)
  // — rendering an empty card is worse than rendering nothing.
  if (result && !result.title && !result.image) result = null

  await redis.set(
    cacheKey,
    result ? JSON.stringify(result) : 'null',
    'EX',
    result ? POSITIVE_TTL_S : NEGATIVE_TTL_S,
  )
  return result
}

function validateUrlString(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new OgUrlError('invalid url')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new OgUrlError('only http(s) urls are supported')
  }
  if (u.username || u.password) throw new OgUrlError('url credentials are not supported')
  // Drop fragment for cache hit-rate (#section doesn't change OG metadata).
  u.hash = ''
  return u.toString()
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  return hostname.toLowerCase().replace(/\.$/, '')
}

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return blockedIpv4.check(ip, 'ipv4')
  if (family === 6) return blockedIpv6.check(ip, 'ipv6')
  return true
}

function isReservedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname === 'home.arpa' || hostname.endsWith('.home.arpa')
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

async function resolvePublicTarget(
  url: URL,
  signal: AbortSignal,
  lookup: OgFetchDependencies['lookup'],
): Promise<ResolvedOgTarget> {
  const hostname = normalizedHostname(url)
  if (!hostname || isReservedHostname(hostname)) {
    throw new OgUrlError('blocked private host', 403)
  }

  const literalFamily = isIP(hostname)
  let addresses: readonly ResolvedAddress[]
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await abortable(lookup(hostname), signal)
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    if (error instanceof OgUrlError) throw error
    throw new OgUrlError('dns lookup failed', 400)
  }

  if (addresses.length === 0) throw new OgUrlError('dns lookup failed', 400)
  for (const answer of addresses) {
    if ((answer.family !== 4 && answer.family !== 6) ||
        isIP(answer.address) !== answer.family || isBlockedIp(answer.address)) {
      throw new OgUrlError('blocked private host', 403)
    }
  }

  const selected = addresses[0]
  return { url, hostname, address: selected.address, family: selected.family }
}

function requestPinnedOg(target: ResolvedOgTarget, signal: AbortSignal): Promise<OgHttpResponse> {
  return new Promise((resolve, reject) => {
    const options: HttpsRequestOptions = {
      protocol: target.url.protocol,
      hostname: target.address,
      family: target.family,
      port: target.url.port ? Number(target.url.port) : undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      agent: false,
      signal,
      headers: {
        host: target.url.host,
        'user-agent': 'Mozilla/5.0 (compatible; CumoraBot/1.0; +https://cumora.ai)',
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9',
      },
    }
    if (target.url.protocol === 'https:' && !isIP(target.hostname)) {
      options.servername = target.hostname
    }

    const onResponse = (response: import('node:http').IncomingMessage) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        cancel: () => response.destroy(),
      })
    }
    const request = target.url.protocol === 'https:'
      ? httpsRequest(options, onResponse)
      : httpRequest(options, onResponse)
    request.once('error', reject)
    request.end()
  })
}

const productionDependencies: OgFetchDependencies = {
  lookup: async hostname => {
    const answers = await dnsLookup(hostname, { all: true, verbatim: true })
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
  },
  request: requestPinnedOg,
}

let ogFetchDependenciesOverride: OgFetchDependencies | null = null

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function readBodyWithCap(
  response: OgHttpResponse,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  const iterator = response.body[Symbol.asyncIterator]()
  for (;;) {
    const { done, value } = await abortable(iterator.next(), signal)
    if (done) break
    if (!value) continue
    const chunk = Buffer.from(value)
    total += chunk.byteLength
    if (total > MAX_BYTES) {
      response.cancel()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function fetchAndParse(url: string, dependencies: OgFetchDependencies): Promise<OgResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const { response: res, finalUrl } = await fetchWithValidatedRedirects(url, ac.signal, dependencies)
    if (res.status < 200 || res.status >= 300) {
      res.cancel()
      throw new OgError(`upstream ${res.status}`, 502)
    }

    const ct = (headerValue(res.headers, 'content-type') ?? '').toLowerCase()
    if (!ct.includes('text/html') && !ct.includes('xhtml')) {
      res.cancel()
      throw new OgError(`unsupported content-type: ${ct || 'unknown'}`, 415)
    }

    const contentLength = headerValue(res.headers, 'content-length')
    if (contentLength !== undefined) {
      const declared = Number(contentLength)
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        res.cancel()
        throw new OgError('upstream body too large', 413)
      }
    }

    let body: Buffer | null
    try {
      body = await readBodyWithCap(res, ac.signal)
    } catch (error) {
      res.cancel()
      throw error
    }
    if (!body) throw new OgError('upstream body too large', 413)
    const html = body.toString('utf8')

    const og: OgResult = { url, finalUrl }
    const title = pickMetaContent(html, 'og:title') ?? pickMetaContent(html, 'twitter:title') ?? pickHtmlTitle(html)
    if (title) og.title = decodeEntities(title).trim().slice(0, 280)
    const desc = pickMetaContent(html, 'og:description') ?? pickMetaContent(html, 'twitter:description') ?? pickMetaName(html, 'description')
    if (desc) og.description = decodeEntities(desc).trim().slice(0, 500)
    const image = pickMetaContent(html, 'og:image') ?? pickMetaContent(html, 'twitter:image') ?? pickMetaContent(html, 'twitter:image:src')
    if (image) og.image = resolveUrl(image, finalUrl)
    const siteName = pickMetaContent(html, 'og:site_name')
    if (siteName) og.siteName = decodeEntities(siteName).trim().slice(0, 80)
    return og
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithValidatedRedirects(
  url: string,
  signal: AbortSignal,
  dependencies: OgFetchDependencies,
): Promise<{ response: OgHttpResponse; finalUrl: string }> {
  let currentUrl = url

  for (let redirectCount = 0; ; redirectCount += 1) {
    const parsedUrl = new URL(currentUrl)
    const target = await resolvePublicTarget(parsedUrl, signal, dependencies.lookup)
    const response = await abortable(dependencies.request(target, signal), signal)

    if (!isRedirectStatus(response.status)) return { response, finalUrl: currentUrl }

    const location = headerValue(response.headers, 'location')
    response.cancel()
    if (!location) throw new OgError('redirect missing location', 502)
    if (redirectCount >= MAX_REDIRECTS) throw new OgError('too many redirects', 502)

    const nextUrl = resolveRedirectUrl(location, currentUrl)
    currentUrl = nextUrl
  }
}

/** Test hook for deterministic DNS answers and socket targets. */
export function __setOgFetchDependenciesForTesting(dependencies: OgFetchDependencies | null): void {
  ogFetchDependenciesOverride = dependencies
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function resolveRedirectUrl(location: string, base: string): string {
  try {
    return validateUrlString(new URL(location, base).toString())
  } catch (e) {
    if (e instanceof OgUrlError) throw e
    throw new OgUrlError('invalid redirect url')
  }
}

/** Tag-attribute parsers. Each meta lookup tries property-first then
 *  content-first so we don't care which attribute order the page used. */
function pickMetaContent(html: string, prop: string): string | null {
  const e = escapeRe(prop)
  return matchFirst(html, new RegExp(`<meta\\b[^>]*\\bproperty\\s*=\\s*['"]${e}['"][^>]*?\\bcontent\\s*=\\s*['"]([^'"]*)['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*['"]([^'"]*)['"][^>]*?\\bproperty\\s*=\\s*['"]${e}['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*['"]${e}['"][^>]*?\\bcontent\\s*=\\s*['"]([^'"]*)['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*['"]([^'"]*)['"][^>]*?\\bname\\s*=\\s*['"]${e}['"]`, 'i'))
}

function pickMetaName(html: string, name: string): string | null {
  const e = escapeRe(name)
  return matchFirst(html, new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*['"]${e}['"][^>]*?\\bcontent\\s*=\\s*['"]([^'"]*)['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*['"]([^'"]*)['"][^>]*?\\bname\\s*=\\s*['"]${e}['"]`, 'i'))
}

function pickHtmlTitle(html: string): string | null {
  return matchFirst(html, /<title[^>]*>([^<]+)<\/title>/i)
}

function matchFirst(s: string, re: RegExp): string | null {
  const m = s.match(re)
  return m?.[1] ? m[1] : null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve a relative URL (og:image often is) against the final response
 *  URL so the renderer doesn't have to. Returns the original on parse
 *  failure so we still try to render — better a broken `<img>` than a
 *  missing card. */
function resolveUrl(href: string, base: string): string {
  try { return new URL(href, base).toString() } catch { return href }
}

/** Minimal HTML entity decode for the common meta-tag escapes. Pages tend
 *  to use `&amp; &quot; &#39; &lt; &gt;` inside content="…"; everything
 *  else passes through as-is. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}
