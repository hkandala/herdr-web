// Maps browser key events onto herdr input.
//
// Herdr's frames are a re-rendering of the pane, so they carry none of the inner
// app's terminal modes (application cursor keys, kitty keyboard protocol, ...).
// A local encoder would guess wrong, so special keys are sent as logical names to
// `pane.send_keys`, and herdr encodes them for whatever the app negotiated.
// `send_keys` has no names for Home/End/PgUp/PgDn/Insert/Delete; those are sent as
// xterm CSI sequences through `pane.send_text`.

export type KeyAction = { keys: string[] } | { text: string }

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

const NAMED: Record<string, string> = {
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'esc',
  Backspace: 'backspace',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

// xterm encodings: CSI <n> ~ or CSI 1 ; <mod> <final>
const CSI_TILDE: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 }
const CSI_FINAL: Record<string, string> = { Home: 'H', End: 'F' }

function modifierPrefix(e: KeyboardEvent, includeShift: boolean): string {
  return (e.ctrlKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (includeShift && e.shiftKey ? 'shift+' : '')
}

/** The base key ignoring layout tricks like macOS Option producing "∫" for Option+B. */
function baseChar(e: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5)
  if (e.key.length === 1) return e.key.toLowerCase()
  return null
}

/**
 * Returns what to send for a keydown, or null to leave the event to the browser
 * (Cmd shortcuts, copy, paste).
 */
export function encodeKey(e: KeyboardEvent): KeyAction | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'AltGraph'].includes(e.key)) return null
  // Windows reports AltGr characters (e.g. @ on German layouts) as Ctrl+Alt.
  if (e.getModifierState?.('AltGraph') && [...e.key].length === 1) return { text: e.key }

  if (e.metaKey) {
    // macOS line-editing conventions; everything else stays a browser shortcut.
    if (!isMac || e.ctrlKey || e.altKey) return null
    if (e.key === 'Backspace') return { keys: ['ctrl+u'] }
    if (e.key === 'ArrowLeft') return { keys: ['ctrl+a'] }
    if (e.key === 'ArrowRight') return { keys: ['ctrl+e'] }
    return null
  }

  // Ctrl+V pastes on Linux/Windows; on macOS it's a real key (e.g. image paste in agents).
  if (!isMac && e.ctrlKey && !e.altKey && e.code === 'KeyV') return null
  if (!isMac && e.ctrlKey && e.shiftKey && e.code === 'KeyC') return null

  if (e.key in NAMED) return { keys: [modifierPrefix(e, true) + NAMED[e.key]] }
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return { keys: [modifierPrefix(e, true) + e.key.toLowerCase()] }

  if (e.key in CSI_TILDE || e.key in CSI_FINAL) {
    const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0)
    if (e.key in CSI_TILDE) return { text: `\x1b[${CSI_TILDE[e.key]}${mod > 1 ? `;${mod}` : ''}~` }
    return { text: mod > 1 ? `\x1b[1;${mod}${CSI_FINAL[e.key]}` : `\x1b[${CSI_FINAL[e.key]}` }
  }

  if (e.ctrlKey || e.altKey) {
    if (e.key === ' ' || e.code === 'Space') return { keys: [modifierPrefix(e, true) + 'space'] }
    const c = baseChar(e)
    if (!c) return null
    const name = c === '+' ? 'plus' : c
    // Letters keep shift as a modifier; for symbols the shifted character already encodes it.
    const shift = /^[a-z]$/.test(name) && e.shiftKey
    return { keys: [modifierPrefix(e, false) + (shift ? 'shift+' : '') + name] }
  }

  if (e.key.length >= 1 && [...e.key].length === 1) return { text: e.key }
  return null
}
