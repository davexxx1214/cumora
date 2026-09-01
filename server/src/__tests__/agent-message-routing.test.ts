import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasExactMention, inheritTargetedReplyAudience, resolveAgentRecipientIds } from '../agents/message-routing.js'

test('exact mentions respect token boundaries and casing', () => {
  assert.equal(hasExactMention('please check this @codex', 'codex'), true)
  assert.equal(hasExactMention('ping @CODEX, please', 'codex'), true)
  assert.equal(hasExactMention('email@codex is not a mention', 'codex'), false)
  assert.equal(hasExactMention('@codex-helper is someone else', 'codex'), false)
})

test('named agent mentions narrow group delivery deterministically', () => {
  const base = { conversationKind: 'group', agentMemberIds: ['codex', 'atlas', 'nova'] }
  assert.deepEqual(resolveAgentRecipientIds({ ...base, body: '@codex please inspect the files' }), ['codex'])
  assert.deepEqual(resolveAgentRecipientIds({ ...base, body: '@atlas and @nova compare notes' }), ['atlas', 'nova'])
})

test('ordinary messages and @all remain broadcasts', () => {
  const base = { conversationKind: 'group', agentMemberIds: ['codex', 'atlas'] }
  assert.equal(resolveAgentRecipientIds({ ...base, body: 'who can help?' }), null)
  assert.equal(resolveAgentRecipientIds({ ...base, body: '@all please check this' }), null)
  assert.equal(resolveAgentRecipientIds({ ...base, body: '@all and @codex please check this' }), null)
})

test('direct messages stay direct and partial ids do not narrow delivery', () => {
  assert.equal(resolveAgentRecipientIds({
    body: '@codex hello', conversationKind: 'direct', agentMemberIds: ['codex'],
  }), null)
  assert.equal(resolveAgentRecipientIds({
    body: '@code hello', conversationKind: 'group', agentMemberIds: ['codex'],
  }), null)
})

test('a directed request does not become a second-hop Agent broadcast', () => {
  assert.deepEqual(inheritTargetedReplyAudience({
    resolvedAudience: null, incomingAudience: ['iris'], replyingAgentId: 'iris',
  }), [])
  assert.equal(inheritTargetedReplyAudience({
    resolvedAudience: null, incomingAudience: ['iris'], replyingAgentId: 'bram',
  }), null)
  assert.deepEqual(inheritTargetedReplyAudience({
    resolvedAudience: ['nova'], incomingAudience: ['iris'], replyingAgentId: 'iris',
  }), ['nova'])
})
