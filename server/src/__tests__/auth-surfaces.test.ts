import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type ComponentType, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { en } from '../../../src/locales/en.js'

let vite: ViteDevServer
let AuthScreen: ComponentType
let SignInToAccept: ComponentType<{ token: string }>
const originals = new Map<string, PropertyDescriptor | undefined>()

before(async () => {
  for (const [name, value] of Object.entries({
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { platform: 'test', language: 'en', languages: ['en'] },
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  vite = await createServer({
    root,
    configFile: false,
    envFile: false,
    appType: 'custom',
    resolve: { alias: { '@': fileURLToPath(new URL('../../../src', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ AuthScreen } = await vite.ssrLoadModule('/src/components/AuthScreen.tsx'))
  ;({ SignInToAccept } = await vite.ssrLoadModule('/src/components/InviteAcceptScreen.tsx'))
})

after(async () => {
  await vite?.close()
  for (const [name, original] of originals) {
    if (original) Object.defineProperty(globalThis, name, original)
    else Reflect.deleteProperty(globalThis, name)
  }
})

function assertLocalPasswordSurface(html: string): void {
  assert.ok(html.includes(en['auth.signIn']))
  assert.ok(html.includes('bg-ink-700'))
  assert.ok(html.includes('text-white'))
  assert.equal(html.includes('bg-ink-800'), false)
  assert.equal(html.includes(en['auth.continueWithGoogle']), false)
  assert.equal(html.includes(en['auth.continueWithGithub']), false)
  assert.equal(html.includes(en['inviteAccept.getCumora']), false)
}

test('self-hosted sign-in renders a visible password button without unavailable providers', () => {
  assertLocalPasswordSurface(renderToStaticMarkup(createElement(AuthScreen)))
})

test('invite sign-in renders a visible password button without OAuth or download prompts', () => {
  assertLocalPasswordSurface(renderToStaticMarkup(createElement(SignInToAccept, { token: 'test-invite-token' })))
})
