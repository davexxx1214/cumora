import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { en } from '../../../src/locales/en.js'
import type { Conversation } from '../../../src/types.js'

let vite: ViteDevServer
let AgentsView: ComponentType
let MobileAgents: ComponentType
let AgentEditor: ComponentType<{ agent: null; onClose: () => void }>
let DissolveGroupDialog: ComponentType<{ conversation: Conversation; onClose: () => void }>
let MobileChatInfo: ComponentType
let authSnapshot: Record<string, unknown>
const originals = new Map<string, PropertyDescriptor | undefined>()
const group: Conversation = { id: 'group-permissions', kind: 'group', title: 'Test group', members: ['viewer','agent'], pinned: false, lastAt: '', lastAtIso: '2026-08-28T00:00:00Z', preview: '' }

before(async () => {
  // Isolated render fixtures, with no browser session or network requests.
  for (const [name, value] of Object.entries({
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { platform: 'test', language: 'en', languages: ['en'] },
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  vite = await createServer({
    root, configFile: false, envFile: false, appType: 'custom',
    resolve: { alias: { '@': fileURLToPath(new URL('../../../src', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ AgentsView } = await vite.ssrLoadModule('/src/desktop/AgentsView.tsx'))
  ;({ MobileAgents } = await vite.ssrLoadModule('/src/mobile/MobileAgents.tsx'))
  ;({ AgentEditor } = await vite.ssrLoadModule('/src/components/AgentEditor.tsx'))
  ;({ DissolveGroupDialog } = await vite.ssrLoadModule('/src/components/DissolveGroupDialog.tsx'))
  ;({ MobileChatInfo } = await vite.ssrLoadModule('/src/mobile/MobileChat.tsx'))
  const { useAuth } = await vite.ssrLoadModule('/src/stores/auth.ts')
  const { useParticipants } = await vite.ssrLoadModule('/src/stores/participants.ts')
  const { useConversations } = await vite.ssrLoadModule('/src/stores/conversations.ts')
  const { useApp } = await vite.ssrLoadModule('/src/stores/app.ts')
  Object.assign(useConversations.getInitialState(), { list: [group] })
  Object.assign(useApp.getInitialState(), { selectedConversationId: group.id })
  // React's server renderer reads Zustand's initial snapshot. Populate that
  // fixture directly; no effects run and no live stores or accounts are used.
  authSnapshot = useAuth.getInitialState()
  Object.assign(authSnapshot, { user: { id: 'viewer', name: 'Viewer' }, activeCompanyId: 'team' })
  const agent = { id: 'agent', kind: 'agent', name: 'Visible teammate', initial: 'A', status: 'avail', avatarBg: '#abcdef' }
  Object.assign(useParticipants.getInitialState(), { byId: {
    agent,
    former: { ...agent, id: 'former', name: 'Former teammate', departedAt: '2026-08-01T00:00:00Z' },
    colleague: { ...agent, id: 'colleague', kind: 'human', name: 'Visible colleague' },
  }, loaded: true })
})

after(async () => {
  await vite?.close()
  for (const [name, original] of originals) {
    if (original) Object.defineProperty(globalThis, name, original)
    else Reflect.deleteProperty(globalThis, name)
  }
})

for (const role of ['owner', 'admin', 'member', 'unknown']) {
  test(`team permissions: ${role} sees only the allowed desktop/mobile actions`, () => {
    authSnapshot.activeCompanyId = 'team'
    authSnapshot.companies = [
      { id: 'team', name: 'Team', role, tier: 'pro' },
      { id: 'other', name: 'Other', role: 'owner', tier: 'pro' },
    ]
    const privileged = role === 'owner' || role === 'admin'
    const desktop = renderToStaticMarkup(createElement(AgentsView))
    const buttons = [...desktop.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0])
    for (const label of [en['agents.newAgent'], en['agents.cardEditAgent'], en['agents.cardOffboardAgent'], en['agents.rehire']]) {
      assert.equal(buttons.some((button) => button.includes(label)), privileged, label)
    }
    assert.ok(buttons.some((button) => button.includes(en['agents.cardChat'])))
    assert.ok(desktop.includes('Visible colleague'))
    const mobile = renderToStaticMarkup(createElement(MobileAgents))
    assert.equal(mobile.includes(en['magents.hireTitle']), privileged)
    assert.ok(mobile.includes('Visible teammate'))
    assert.ok(mobile.includes('Visible colleague'))
    const editor = renderToStaticMarkup(createElement(AgentEditor, { agent: null, onClose: () => {} }))
    assert.equal(editor.length > 0, privileged)
  })
}

for (const role of ['owner', 'admin', 'member', 'unknown']) {
  test(`group permissions: ${role} can only confirm dissolution when privileged`, () => {
    authSnapshot.companies = [{ id: 'team', role }, { id: 'other', role: 'owner' }]
    const privileged = role === 'owner' || role === 'admin'
    const dialog = renderToStaticMarkup(createElement(DissolveGroupDialog, { conversation: group, onClose: () => {} }))
    assert.equal(dialog.includes('role="alertdialog"'),privileged)
    if (privileged) {
      assert.ok(dialog.includes(en['convo.dissolveWarning']))
      assert.ok(dialog.includes(en['common.cancel']))
      assert.ok(dialog.includes(en['convo.confirmDissolve']))
    }
    const mobile = renderToStaticMarkup(createElement(MobileChatInfo))
    assert.equal(mobile.includes(en['convo.dissolveGroup']),privileged)
    for (const inaccessible of [{ ...group, kind: 'direct' as const }, { ...group, members: ['agent'] }]) {
      assert.equal(renderToStaticMarkup(createElement(DissolveGroupDialog, { conversation: inaccessible, onClose: () => {} })), '')
    }
  })
}

test('dissolved groups clear selection and caches and cannot return through a stale fetch or stream', async () => {
  const { useConversations, removeConversation } = await vite.ssrLoadModule('/src/stores/conversations.ts')
  const { useMessages } = await vite.ssrLoadModule('/src/stores/messages.ts')
  const { useApp } = await vite.ssrLoadModule('/src/stores/app.ts')
  const { api } = await vite.ssrLoadModule('/src/api/client.ts')
  const originalList = api.getConversations, originalMessages = api.getMessages
  const id = 'dissolved-store-fixture'
  let finishList!: (value: unknown[]) => void
  let finishMessages!: (value: unknown[]) => void
  api.getConversations = () => new Promise((resolve) => { finishList = resolve })
  api.getMessages = () => new Promise((resolve) => { finishMessages = resolve })
  try {
    useApp.getState().selectConversation(id)
    useApp.getState().setReplyingTo(id,'quoted-old-message')
    useConversations.setState({list:[{...group,id}]})
    useMessages.setState({ byConvo: {[id]:[{id:'old-message',body:'old text'}]}, loaded:new Set(),
      streaming:{'stream':{conversationId:id,body:'partial'}}, typing:{[id]:['agent']} })
    const listRequest = useConversations.getState().reload()
    const messageRequest = useMessages.getState().loadConversation(id)
    removeConversation(id)
    finishList([{ ...group, id }])
    finishMessages([])
    await Promise.all([listRequest,messageRequest])
    useMessages.getState().applyEvent({type:'typing',conversationId:id,agentId:'agent',done:false})
    assert.equal(useApp.getState().selectedConversationId,null)
    assert.equal(useApp.getState().mobileStack,'list')
    assert.equal(useApp.getState().replyingTo[id],undefined)
    assert.deepEqual(useConversations.getState().list,[])
    assert.equal(useMessages.getState().byConvo[id],undefined)
    assert.equal(useMessages.getState().typing[id],undefined)
    assert.equal(useMessages.getState().loaded.has(id),false)
    assert.equal(useMessages.getState().loading.has(id),false)
    assert.deepEqual(useMessages.getState().streaming,{})
  } finally {
    api.getConversations = originalList
    api.getMessages = originalMessages
  }
})
