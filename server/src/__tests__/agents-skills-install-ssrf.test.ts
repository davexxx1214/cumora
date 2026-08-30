import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

process.env.OPENAI_API_KEY ??= 'test-key'

const { fetchSkillManifest } = await import('../agents/skills.js')

const savedFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = savedFetch
})

test('skill manifest fetch rejects an explicit HTTP URL before any network request', async () => {
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('network must not be reached')
  }) as typeof fetch

  await assert.rejects(
    fetchSkillManifest('http://169.254.169.254/latest/meta-data/', 'https://skills.example.test'),
    /explicit install URLs are not allowed/i,
  )
  assert.equal(fetchCalls, 0)
})

test('skill ids are encoded beneath the configured hub and redirects are disabled', async () => {
  let seenUrl = ''
  let seenInit: RequestInit | undefined
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input)
    seenInit = init
    return new Response(JSON.stringify({
      name: 'safe-skill',
      description: 'A safe test skill',
      files: [{ path: 'SKILL.md', body: '---\nname: safe-skill\ndescription: A safe test skill\n---\n' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const manifest = await fetchSkillManifest('safe/../skill', 'https://skills.example.test/catalog')

  assert.equal(seenUrl, 'https://skills.example.test/catalog/skills/safe%2F..%2Fskill')
  assert.equal(seenInit?.redirect, 'error')
  assert.equal(manifest.name, 'safe-skill')
})

test('protocol-relative install targets are rejected before any network request', async () => {
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('network must not be reached')
  }) as typeof fetch

  await assert.rejects(
    fetchSkillManifest('//internal.service/manifest', 'https://skills.example.test'),
    /explicit install URLs are not allowed/i,
  )
  assert.equal(fetchCalls, 0)
})
