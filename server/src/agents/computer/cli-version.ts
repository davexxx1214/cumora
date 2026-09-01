/** Local-only engine version probing used by the secure BYOA capability gate. */
import { spawn } from 'node:child_process'

const VERSION_ARGS: Readonly<Record<string, readonly string[]>> = {
  claude: ['--version'],
  codex: ['--version'],
  grok: ['--version'],
  cursor: ['--version'],
}

export function parseCliVersion(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.match(/v?(\d{4}\.\d{2}\.\d{2}(?:-[\w.]+)?|\d+\.\d+\.\d+(?:[-+][\w.]+)?)/i)
  return match?.[1] ?? null
}

function versionParts(version: string): number[] {
  const main = version.replace(/^v/i, '').split(/[-+]/)[0] ?? ''
  return main.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function isCliVersionAtLeast(current: string | null, minimum: string): boolean {
  if (!current) return false
  const actual = versionParts(current)
  const required = versionParts(minimum)
  for (let i = 0; i < Math.max(actual.length, required.length); i += 1) {
    if ((actual[i] ?? 0) > (required[i] ?? 0)) return true
    if ((actual[i] ?? 0) < (required[i] ?? 0)) return false
  }
  const currentMain = current.trim().replace(/^v/i, '').split('+', 1)[0]
  const minimumMain = minimum.trim().replace(/^v/i, '').split('+', 1)[0]
  return !(currentMain.includes('-') && !minimumMain.includes('-'))
}

export function probeLocalEngineVersion(id: string, command: string): Promise<string | null> {
  const args = VERSION_ARGS[id]
  if (!args) return Promise.resolve(null)
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(parseCliVersion(output))
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' })
    } catch {
      resolve(null)
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const timer = setTimeout(() => { try { child.kill() } catch { /* already exited */ }; finish() }, 6_000)
    child.on('error', finish)
    child.on('close', finish)
  })
}
