/** Copy plain text and report only a confirmed browser operation as success.
 * Modern Clipboard API is preferred; execCommand is the compatibility path
 * for embedded browsers and permission policies that reject writeText(). */
export async function copyText(text: string): Promise<void> {
  let nativeError: unknown = null
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch (error) {
      nativeError = error
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    throw nativeError instanceof Error ? nativeError : new Error('Clipboard API unavailable')
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const input = document.createElement('textarea')
  input.value = text
  input.readOnly = true
  input.setAttribute('aria-hidden', 'true')
  Object.assign(input.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
    opacity: '0',
    pointerEvents: 'none',
  })
  document.body.appendChild(input)
  input.focus()
  input.select()
  input.setSelectionRange(0, input.value.length)
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard copy was rejected')
  } finally {
    input.remove()
    active?.focus()
  }
}

