import { init, Terminal } from 'ghostty-web'
import { useEffect, useRef, useState } from 'react'
import type { MouseButton, StreamMode } from '@shared/protocol'
import { RotateCw, ShieldAlert } from 'lucide-react'
import { bridge, type StreamEvent } from '@/lib/bridge'
import { encodeKey } from '@/lib/keys'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Nerd Font icons (powerline, devicons, ...) live in the Private Use Area, which no
// system monospace font covers. The bundled symbols font sits in the fallback chain;
// it must be loaded before the first paint because the canvas only rasterizes once.
const TERMINAL_FONT =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Symbols Nerd Font Mono", monospace'

const ghosttyReady = Promise.all([
  init(),
  document.fonts.load('13px "Symbols Nerd Font Mono"', '\ue0b0\uf113').catch(() => undefined),
])

const MOUSE_BUTTONS: (MouseButton | undefined)[] = ['left', 'middle', 'right']

const THEME = {
  background: '#0c0c0d',
  foreground: '#d6d6d6',
  cursor: '#d6d6d6',
  cursorAccent: '#0c0c0d',
  selectionBackground: '#3a3d41',
  black: '#1d1f21',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d6d6d6',
  brightBlack: '#5c6370',
  brightRed: '#f28b94',
  brightGreen: '#b5e08f',
  brightYellow: '#f2d49b',
  brightBlue: '#82c4ff',
  brightMagenta: '#d99cf0',
  brightCyan: '#7fd3dd',
  brightWhite: '#ffffff',
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface Props {
  paneId: string
  mode: StreamMode
  /** Control mode: the font size the grid is computed from. Mirror mode scales to fit. */
  fontSize: number
  /** Bracketed paste is wrapped manually because frames don't carry the app's paste mode. */
  bracketedPaste: boolean
  active: boolean
  onActivate?: () => void
  className?: string
}

interface Closed {
  reason: string
  code?: 'held' | 'gone' | 'error'
}

export function TerminalView({ paneId, mode, fontSize, bracketedPaste, active, onActivate, className }: Props) {
  const outerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const refitRef = useRef<() => void>(() => {})
  const pasteRef = useRef(bracketedPaste)
  pasteRef.current = bracketedPaste
  const activeRef = useRef(active)
  activeRef.current = active
  const [closed, setClosed] = useState<Closed | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [takeover, setTakeover] = useState(false)

  useEffect(() => {
    const outer = outerRef.current!
    const host = hostRef.current!
    let disposed = false
    let sid: string | null = null
    let term: Terminal | null = null
    let resizeObs: ResizeObserver | null = null
    let resizeTimer: number | undefined
    let wheelRemainder = 0
    const cleanups: (() => void)[] = []

    const cellSize = () => {
      const m = term?.renderer?.getMetrics()
      return m && m.width > 0 && m.height > 0 ? m : null
    }

    // Mirror: the grid is fixed by herdr, so pick the largest font that fits the box.
    const fitFont = () => {
      if (!term || mode !== 'mirror') return
      const box = outer.getBoundingClientRect()
      const cell = cellSize()
      if (!cell || box.width < 10 || box.height < 10) return
      const current = term.options.fontSize
      const scale = Math.min(box.width / (term.cols * cell.width), box.height / (term.rows * cell.height))
      const next = Math.max(5, Math.min(18, Math.floor(current * scale * 2) / 2))
      if (Math.abs(next - current) >= 0.5) {
        term.options.fontSize = next
        // Metrics aren't exactly linear in font size; settle in a second pass.
        requestAnimationFrame(() => {
          const c = cellSize()
          if (!term || !c) return
          if (term.cols * c.width > box.width + 1 || term.rows * c.height > box.height + 1) {
            term.options.fontSize = Math.max(5, term.options.fontSize - 0.5)
          }
        })
      }
    }

    // Control: the browser owns the grid size.
    const proposeGrid = () => {
      const box = outer.getBoundingClientRect()
      const cell = cellSize()
      // No real box yet (e.g. mounted while laid out at zero size): wait rather
      // than resize the herdr pane to a placeholder.
      if (!cell || box.width < 60 || box.height < 40) return null
      return {
        cols: Math.max(20, Math.floor((box.width - 4) / cell.width)),
        rows: Math.max(5, Math.floor((box.height - 4) / cell.height)),
      }
    }

    // Control mode: clicks and drags go to herdr, which encodes them for the app's
    // mouse mode (or drops them if it has none). Shift-drag stays a local selection,
    // as in most terminals. Right-click keeps the browser menu.
    const forwardMouse = () => {
      let pressed: MouseButton | null = null
      let lastCell = ''
      const cellAt = (e: MouseEvent) => {
        const canvas = host.querySelector('canvas')
        const cell = cellSize()
        if (!canvas || !cell || !term) return null
        const r = canvas.getBoundingClientRect()
        return {
          column: Math.max(0, Math.min(term.cols - 1, Math.floor((e.clientX - r.left) / cell.width))),
          row: Math.max(0, Math.min(term.rows - 1, Math.floor((e.clientY - r.top) / cell.height))),
        }
      }
      const mods = (e: MouseEvent) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0)
      const onMove = (e: MouseEvent) => {
        if (!sid || !pressed) return
        const c = cellAt(e)
        if (!c || `${c.column},${c.row}` === lastCell) return
        lastCell = `${c.column},${c.row}`
        bridge.mouse(sid, 'drag', pressed, c.column, c.row, mods(e))
      }
      const onUp = (e: MouseEvent) => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        const c = cellAt(e)
        if (sid && pressed && c) bridge.mouse(sid, 'up', pressed, c.column, c.row, mods(e))
        pressed = null
      }
      const onDown = (e: MouseEvent) => {
        if (!sid || e.shiftKey || pressed) return
        if ((e.target as HTMLElement).closest?.('[data-overlay]')) return
        const button = MOUSE_BUTTONS[e.button]
        if (!button || button === 'right') return
        const c = cellAt(e)
        if (!c) return
        pressed = button
        lastCell = `${c.column},${c.row}`
        bridge.mouse(sid, 'down', button, c.column, c.row, mods(e))
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
      outer.addEventListener('mousedown', onDown, true)
      return () => {
        outer.removeEventListener('mousedown', onDown, true)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
    }

    const onEvent = (e: StreamEvent) => {
      if (!term) return
      if (e.t === 'geometry') {
        if (term.cols !== e.cols || term.rows !== e.rows) term.resize(e.cols, e.rows)
        fitFont()
      } else if (e.t === 'frame') {
        if (term.cols !== e.cols || term.rows !== e.rows) term.resize(e.cols, e.rows)
        term.write(decodeBase64(e.data))
      } else {
        sid = null
        setClosed({ reason: e.reason, code: e.code })
      }
    }

    void ghosttyReady.then(() => {
      if (disposed) return
      term = new Terminal({
        fontSize: mode === 'mirror' ? 12 : fontSize,
        fontFamily: TERMINAL_FONT,
        theme: THEME,
        scrollback: 0,
        cursorBlink: false,
        cols: 80,
        rows: 24,
      })
      termRef.current = term
      term.open(host)
      // open() focuses the terminal (again on a 0ms timer), so in a grid the last
      // pane to open would steal the keyboard. Settle focus after ghostty's timer.
      const focusTimer = window.setTimeout(() => {
        if (disposed || !term) return
        if (activeRef.current) term.focus()
        else if (host.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      }, 20)
      cleanups.push(() => clearTimeout(focusTimer))

      // Typing from IME composition and mobile keyboards arrives here. Ghostty also
      // emits replies to terminal queries (DA/DSR) on this channel; those start with
      // ESC and must not be typed into the pane.
      cleanups.push(
        term.onData((data) => {
          if (!data.startsWith('\x1b')) bridge.sendText(paneId, data)
        }).dispose,
      )

      term.attachCustomWheelEventHandler((ev) => {
        if (!sid) return true
        const cell = cellSize()
        const px = ev.deltaMode === 1 ? ev.deltaY * (cell?.height ?? 16) : ev.deltaY
        wheelRemainder += px / (cell?.height ?? 16)
        const lines = Math.trunc(wheelRemainder)
        if (lines !== 0) {
          wheelRemainder -= lines
          bridge.scroll(sid, lines < 0 ? 'up' : 'down', Math.abs(lines))
        }
        return true
      })

      // Control attaches only once the box has a real size (see proposeGrid).
      let started = false
      const start = () => {
        if (started || !term) return
        if (mode === 'mirror') {
          started = true
          sid = bridge.openStream({ paneId, mode, onEvent })
          return
        }
        const grid = proposeGrid()
        if (!grid) return
        started = true
        term.resize(grid.cols, grid.rows)
        sid = bridge.openStream({ paneId, mode, ...grid, takeover, onEvent })
      }
      start()

      if (mode === 'control') cleanups.push(forwardMouse())

      const refit = () => {
        if (!term) return
        if (!started) return start()
        if (mode === 'mirror') return fitFont()
        const grid = proposeGrid()
        if (!grid || !sid || (grid.cols === term.cols && grid.rows === term.rows)) return
        term.resize(grid.cols, grid.rows)
        bridge.resizeStream(sid, grid.cols, grid.rows)
      }
      refitRef.current = refit
      resizeObs = new ResizeObserver(() => {
        clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(refit, 80)
      })
      resizeObs.observe(outer)
    })

    // Capture-phase so ghostty's own encoder never sees the key (see lib/keys.ts).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if ((e.target as HTMLElement).closest?.('[data-overlay]')) return
      e.stopPropagation()
      const action = encodeKey(e)
      if (!action) return
      e.preventDefault()
      if ('keys' in action) bridge.sendKeys(paneId, action.keys)
      else bridge.sendText(paneId, action.text)
    }
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      const normalized = text.replace(/\r?\n/g, '\r')
      bridge.sendText(paneId, pasteRef.current ? `\x1b[200~${normalized}\x1b[201~` : normalized)
    }
    outer.addEventListener('keydown', onKeyDown, true)
    outer.addEventListener('paste', onPaste, true)

    return () => {
      disposed = true
      outer.removeEventListener('keydown', onKeyDown, true)
      outer.removeEventListener('paste', onPaste, true)
      clearTimeout(resizeTimer)
      resizeObs?.disconnect()
      if (sid) bridge.closeStream(sid)
      for (const fn of cleanups) fn()
      term?.dispose()
      termRef.current = null
      refitRef.current = () => {}
    }
    // fontSize is applied live by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, mode, attempt])

  useEffect(() => {
    const term = termRef.current
    if (!term || mode !== 'control' || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    requestAnimationFrame(() => refitRef.current())
  }, [fontSize, mode])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active, attempt])

  const retry = (withTakeover: boolean) => {
    setTakeover(withTakeover)
    setClosed(null)
    setAttempt((n) => n + 1)
  }

  return (
    <div
      ref={outerRef}
      onMouseDown={onActivate}
      className={cn('relative flex h-full w-full items-center-safe justify-center-safe overflow-hidden bg-[#0c0c0d]', className)}
    >
      <div ref={hostRef} className="terminal-host [&_canvas]:block" />
      {closed && (
        <div data-overlay className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-center backdrop-blur-[1px]">
          <ShieldAlert className="size-5 text-muted-foreground" />
          <p className="max-w-md text-xs text-muted-foreground">
            {closed.code === 'held'
              ? 'Another client is controlling this terminal.'
              : closed.code === 'gone'
                ? 'This terminal is no longer available.'
                : 'The terminal stream stopped.'}
            <span className="mt-1 block font-mono text-[11px] opacity-70">{closed.reason}</span>
          </p>
          <div className="flex gap-2">
            <Button size="xs" variant="outline" onClick={() => retry(false)}>
              <RotateCw /> Retry
            </Button>
            {closed.code === 'held' && (
              <Button size="xs" variant="secondary" onClick={() => retry(true)}>
                Take over
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
