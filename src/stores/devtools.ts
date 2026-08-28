import { create } from 'zustand'
import { api, setDevModeEnabled, type ApiDevtoolsCapabilities } from '@/api/client'
import { commitIfContextCurrent } from '@/stores/auth'

interface DevtoolsState extends ApiDevtoolsCapabilities {
  loaded: boolean
  load: () => Promise<void>
  setDevMode: (enabled: boolean) => Promise<void>
}

const DEFAULT_CAPS: ApiDevtoolsCapabilities = {
  enabled: false,
  canEnable: false,
  localDev: false,
  productionDevMode: false,
  role: 'member',
}

export const useDevtools = create<DevtoolsState>((set, get) => ({
  ...DEFAULT_CAPS,
  loaded: false,
  async load() {
    await commitIfContextCurrent(async () => {
      try { return await api.getDevtoolsCapabilities() }
      catch (err) {
        console.warn('[devtools] capability check failed', err)
        return DEFAULT_CAPS
      }
    }, (caps) => set({ ...caps, loaded: true }))
  },
  async setDevMode(enabled) {
    setDevModeEnabled(enabled)
    await get().load()
  },
}))
