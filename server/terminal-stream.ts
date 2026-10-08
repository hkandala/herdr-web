// Live terminal output via `herdr terminal session observe|control <terminal_id>`.
//
// Both subcommands print NDJSON on stdout:
//   {"type":"terminal.frame","seq":1,"full":true,"width":80,"height":24,"encoding":"ansi","bytes":"<base64>"}
//   {"type":"terminal.closed","reason":"..."}
// Frames are herdr's own rendering of the pane surface: a full repaint first (and
// after every resize), then cursor-addressed deltas wrapped in synchronized output.
//
// - observe renders at the requested size without touching the pane. Any number of
//   observers can coexist, alongside one controller.
// - control is the single interactive attachment. It resizes the herdr terminal to
//   its size and reads NDJSON commands on stdin (terminal.input / terminal.resize /
//   terminal.scroll / terminal.release). A second controller is refused unless it
//   passes --takeover.

import { spawn, type ChildProcess } from 'node:child_process'
import type { MouseAction, MouseButton, StreamMode } from '../shared/protocol.ts'
import { herdrBinary } from './herdr.ts'

export interface Frame {
  full: boolean
  cols: number
  rows: number
  data: string
}

export interface StreamOptions {
  sock: string
  terminalId: string
  mode: StreamMode
  cols: number
  rows: number
  takeover?: boolean
  onFrame: (frame: Frame) => void
  onClosed: (reason: string, code: 'held' | 'gone' | 'error') => void
}

export function clampSize(n: unknown, fallback: number): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) && v >= 2 && v <= 1000 ? v : fallback
}

export class TerminalStream {
  private opts: StreamOptions
  cols: number
  rows: number
  private child: ChildProcess | null = null
  private disposed = false
  // Bumped whenever a child is replaced so exits from old children are ignored.
  private generation = 0

  constructor(opts: StreamOptions) {
    this.opts = opts
    this.cols = opts.cols
    this.rows = opts.rows
    this.spawn()
  }

  private spawn() {
    const gen = ++this.generation
    const { mode, terminalId, sock, takeover } = this.opts
    const args = [
      'terminal',
      'session',
      mode === 'control' ? 'control' : 'observe',
      terminalId,
      '--cols',
      String(this.cols),
      '--rows',
      String(this.rows),
    ]
    if (mode === 'control' && takeover) args.push('--takeover')
    const child = spawn(herdrBinary(), args, {
      // The CLI resolves terminals against HERDR_SOCKET_PATH, not the default session.
      env: { ...process.env, HERDR_SOCKET_PATH: sock, HERDR_ENV: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    let closedReason: string | null = null
    let buf = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      if (gen !== this.generation) return
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === 'terminal.frame' && typeof msg.bytes === 'string') {
          this.opts.onFrame({
            full: Boolean(msg.full),
            cols: msg.width ?? this.cols,
            rows: msg.height ?? this.rows,
            data: msg.bytes,
          })
        } else if (msg.type === 'terminal.closed') {
          closedReason = String(msg.reason ?? 'closed')
        }
      }
    })
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.stdin!.on('error', () => {})
    child.on('error', (e) => {
      if (gen !== this.generation || this.disposed) return
      this.disposed = true
      this.opts.onClosed(`failed to start herdr: ${e.message}`, 'error')
    })
    // 'close' (not 'exit') fires after stdout/stderr drain, so the reason is complete.
    child.on('close', () => {
      if (gen !== this.generation || this.disposed) return
      this.disposed = true
      const reason = closedReason ?? (stderr.trim() || 'stream ended')
      const code = /already has an attached client|takeover/i.test(reason)
        ? 'held'
        : /not found|detached|exited/i.test(reason)
          ? 'gone'
          : 'error'
      this.opts.onClosed(reason, code)
    })
  }

  private send(cmd: Record<string, unknown>) {
    const stdin = this.child?.stdin
    if (stdin && !stdin.destroyed) stdin.write(JSON.stringify(cmd) + '\n')
  }

  resize(cols: number, rows: number) {
    if (this.disposed || (cols === this.cols && rows === this.rows)) return
    this.cols = cols
    this.rows = rows
    if (this.opts.mode === 'control') {
      this.send({ type: 'terminal.resize', cols, rows })
    } else {
      // Observers are sized at spawn; restart to re-render at the new size.
      const old = this.child
      this.spawn()
      old?.kill()
    }
  }

  scroll(direction: 'up' | 'down', lines: number) {
    if (this.opts.mode === 'control') this.send({ type: 'terminal.scroll', direction, lines })
  }

  mouse(action: MouseAction, button: MouseButton | undefined, column: number, row: number, modifiers: number) {
    if (this.opts.mode !== 'control') return
    this.send({ type: 'terminal.mouse', action, ...(button ? { button } : {}), column, row, modifiers })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    const child = this.child
    if (!child) return
    if (this.opts.mode === 'control') {
      this.send({ type: 'terminal.release' })
      child.stdin?.end()
      setTimeout(() => child.kill(), 500).unref()
    } else {
      child.kill()
    }
  }
}
