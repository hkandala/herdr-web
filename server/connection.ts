// One browser WebSocket. Owns the pane streams that browser has open and the
// per-pane input queues, and relays the session snapshot.

import type { WebSocket } from 'ws'
import {
  ALLOWED_RPC,
  type ClientMsg,
  type PaneInfo,
  type ServerMsg,
  type SessionEntry,
  type SessionSnapshot,
  type StreamMode,
} from '../shared/protocol.ts'
import { HerdrError, listSessions, rpc } from './herdr.ts'
import { getHub, type SessionHub } from './session-hub.ts'
import { clampSize, TerminalStream } from './terminal-stream.ts'

const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/
const MAX_BUFFERED = 4 * 1024 * 1024

/**
 * Sizes set by our own control streams, keyed by `${session}|${terminalId}`. A
 * controller resizes the herdr terminal but herdr's layout rect keeps reporting
 * the TUI's geometry, so mirrors of that terminal look here first.
 */
const controlSizes = new Map<string, { cols: number; rows: number; owner: object }>()
const connections = new Set<Connection>()

/** Mirrors in every connection on this session re-derive their size. */
function controlSizesChanged(session: string) {
  for (const c of connections) c.reconcileSession(session)
}

function setControlSize(key: string, size: { cols: number; rows: number }, owner: object) {
  controlSizes.set(key, { ...size, owner })
  controlSizesChanged(key.slice(0, key.indexOf('|')))
}

/** Only the stream that set an override may clear it (a refused or replaced controller must not). */
function clearControlSize(key: string, owner: object) {
  if (controlSizes.get(key)?.owner !== owner) return
  controlSizes.delete(key)
  controlSizesChanged(key.slice(0, key.indexOf('|')))
}

/**
 * The terminal's real size as best the public API reveals it. Rows come from
 * `scroll.viewport_rows`. Columns aren't reported, but the layout rect includes
 * herdr's pane border when a TUI is attached (rect = inner + 2), which shows up
 * as the same difference on the rows.
 */
function nativeSize(session: string, snapshot: SessionSnapshot, pane: PaneInfo) {
  const override = controlSizes.get(`${session}|${pane.terminal_id}`)
  if (override) return { cols: override.cols, rows: override.rows }
  const rect = snapshot.layouts
    .find((l) => l.tab_id === pane.tab_id)
    ?.panes.find((p) => p.pane_id === pane.pane_id)?.rect
  const vr = pane.scroll?.viewport_rows
  if (!rect) return { cols: 120, rows: clampSize(vr, 40) }
  if (!vr) return { cols: clampSize(rect.width, 120), rows: clampSize(rect.height, 40) }
  const border = rect.height - vr
  const cols = border >= 0 && border <= 2 ? rect.width - border : rect.width
  return { cols: clampSize(cols, 120), rows: clampSize(vr, 40) }
}

type Job =
  | { kind: 'text'; text: string }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'scroll'; delta: number }

interface OpenStream {
  stream: TerminalStream
  paneId: string
  terminalId: string
  mode: StreamMode
  stale: boolean
  /** Control only: herdr accepted us as the controller (first frame arrived). */
  confirmed: boolean
}

export class Connection {
  private ws: WebSocket
  private sessionName = 'default'
  private hub: SessionHub | null = null
  private unlisten: (() => void) | null = null
  private streams = new Map<string, OpenStream>()
  private queues = new Map<string, { jobs: Job[]; running: boolean }>()
  private sessions: SessionEntry[] = []
  private sessionsTimer: NodeJS.Timeout
  private closed = false

  constructor(ws: WebSocket, initialSession: string | null) {
    this.ws = ws
    connections.add(this)
    ws.on('message', (raw) => this.onMessage(raw.toString()))
    ws.on('close', () => this.dispose())
    ws.on('error', () => this.dispose())
    this.sessionsTimer = setInterval(() => void this.refreshSessions(true), 10_000)
    void this.init(initialSession)
  }

  private send(msg: ServerMsg) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  private async init(initialSession: string | null) {
    this.sessions = await listSessions()
    if (this.closed) return
    const wanted = initialSession && SESSION_NAME.test(initialSession) ? initialSession : null
    const name =
      wanted ??
      (this.sessions.find((s) => s.name === 'default' && s.running) ?? this.sessions.find((s) => s.running))
        ?.name ??
      'default'
    this.send({ t: 'hello', sessions: this.sessions, session: name })
    this.switchSession(name)
  }

  private async refreshSessions(onlyIfChanged: boolean) {
    const next = await listSessions()
    if (this.closed) return
    if (onlyIfChanged && JSON.stringify(next) === JSON.stringify(this.sessions)) return
    this.sessions = next
    this.send({ t: 'sessions', sessions: next })
  }

  private switchSession(name: string) {
    for (const sid of [...this.streams.keys()]) this.closeStream(sid)
    this.unlisten?.()
    this.sessionName = name
    this.hub = getHub(name)
    this.unlisten = this.hub.addListener((snapshot, error) => {
      this.send({ t: 'snapshot', session: name, snapshot, error })
      if (snapshot) this.reconcileStreams(snapshot)
    })
  }

  private onMessage(raw: string) {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw)
    } catch {
      return this.send({ t: 'error', message: 'invalid JSON' })
    }
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'session':
        if (SESSION_NAME.test(msg.name)) {
          this.switchSession(msg.name)
          void this.refreshSessions(false)
        }
        break
      case 'open':
        this.openStream(msg)
        break
      case 'close':
        this.closeStream(msg.sid)
        break
      case 'resize':
        this.resizeControl(msg.sid, msg.cols, msg.rows)
        break
      case 'input':
        if (typeof msg.text === 'string' && msg.text) this.enqueue(msg.paneId, { kind: 'text', text: msg.text })
        if (Array.isArray(msg.keys) && msg.keys.length)
          this.enqueue(msg.paneId, { kind: 'keys', keys: msg.keys.map(String) })
        break
      case 'scroll': {
        const s = this.streams.get(msg.sid)
        if (!s) break
        const lines = Math.max(1, Math.min(200, Math.floor(msg.lines) || 1))
        if (s.mode === 'control') s.stream.scroll(msg.direction, lines)
        else this.enqueue(s.paneId, { kind: 'scroll', delta: msg.direction === 'up' ? lines : -lines })
        break
      }
      case 'mouse': {
        const s = this.streams.get(msg.sid)
        if (!s || s.mode !== 'control') break
        if (!['down', 'up', 'drag', 'move'].includes(msg.action)) break
        const button = msg.button && ['left', 'right', 'middle'].includes(msg.button) ? msg.button : undefined
        const column = Math.max(0, Math.min(s.stream.cols - 1, Math.floor(msg.column) || 0))
        const row = Math.max(0, Math.min(s.stream.rows - 1, Math.floor(msg.row) || 0))
        s.stream.mouse(msg.action, button, column, row, (Number(msg.modifiers) || 0) & 7)
        break
      }
      case 'rpc':
        void this.handleRpc(msg.id, msg.method, msg.params)
        break
    }
  }

  private findPane(paneId: string): PaneInfo | undefined {
    return this.hub?.snapshot?.panes.find((p) => p.pane_id === paneId)
  }

  private openStream(msg: Extract<ClientMsg, { t: 'open' }>) {
    const { sid, paneId, mode } = msg
    this.closeStream(sid)
    const hub = this.hub
    const snapshot = hub?.snapshot
    const pane = this.findPane(paneId)
    if (!hub || !snapshot || !pane) {
      return this.send({ t: 'closed', sid, reason: 'pane not found', code: 'gone' })
    }
    if (pane.restore_error) {
      return this.send({ t: 'closed', sid, reason: pane.restore_error, code: 'error' })
    }
    const size =
      mode === 'control'
        ? { cols: clampSize(msg.cols, 80), rows: clampSize(msg.rows, 24) }
        : nativeSize(this.sessionName, snapshot, pane)
    this.startStream(sid, pane, mode, size, Boolean(msg.takeover))
  }

  private startStream(
    sid: string,
    pane: PaneInfo,
    mode: StreamMode,
    size: { cols: number; rows: number },
    takeover: boolean,
  ) {
    const hub = this.hub!
    const sizeKey = `${this.sessionName}|${pane.terminal_id}`
    this.send({ t: 'geometry', sid, ...size })
    const entry: OpenStream = {
      paneId: pane.pane_id,
      terminalId: pane.terminal_id,
      mode,
      stale: false,
      confirmed: false,
      stream: new TerminalStream({
        sock: hub.sock,
        terminalId: pane.terminal_id,
        mode,
        ...size,
        takeover,
        onFrame: (frame) => {
          if (mode === 'control' && !entry.confirmed) {
            entry.confirmed = true
            setControlSize(sizeKey, { cols: entry.stream.cols, rows: entry.stream.rows }, entry)
            hub.scheduleRefresh(150)
          }
          // A browser that can't keep up would apply deltas onto a screen it never
          // received. Drop frames while backed up, then repaint from scratch.
          if (this.ws.bufferedAmount > MAX_BUFFERED && mode === 'mirror') {
            entry.stale = true
            return
          }
          if (entry.stale) {
            entry.stale = false
            if (!frame.full) {
              const { cols, rows } = entry.stream
              entry.stream.dispose()
              this.startStream(sid, pane, mode, { cols, rows }, false)
              return
            }
          }
          this.send({ t: 'frame', sid, ...frame })
        },
        onClosed: (reason, code) => {
          if (this.streams.get(sid) !== entry) return
          this.streams.delete(sid)
          if (mode === 'control') {
            clearControlSize(sizeKey, entry)
            hub.scheduleRefresh(100)
          }
          this.send({ t: 'closed', sid, reason, code })
        },
      }),
    }
    this.streams.set(sid, entry)
  }

  private resizeControl(sid: string, cols: number, rows: number) {
    const s = this.streams.get(sid)
    if (!s || s.mode !== 'control') return
    const size = { cols: clampSize(cols, s.stream.cols), rows: clampSize(rows, s.stream.rows) }
    s.stream.resize(size.cols, size.rows)
    if (s.confirmed) setControlSize(`${this.sessionName}|${s.terminalId}`, size, s)
    this.send({ t: 'geometry', sid, ...size })
    this.hub?.scheduleRefresh(150)
  }

  private closeStream(sid: string) {
    const s = this.streams.get(sid)
    if (!s) return
    this.streams.delete(sid)
    s.stream.dispose()
    if (s.mode === 'control') {
      clearControlSize(`${this.sessionName}|${s.terminalId}`, s)
      this.hub?.scheduleRefresh(300)
    }
  }

  reconcileSession(session: string) {
    if (!this.closed && session === this.sessionName && this.hub?.snapshot) this.reconcileStreams(this.hub.snapshot)
  }

  /** Keeps open streams in step with the session: resizes, handoffs, closed panes. */
  private reconcileStreams(snapshot: SessionSnapshot) {
    for (const [sid, s] of [...this.streams]) {
      const pane = snapshot.panes.find((p) => p.pane_id === s.paneId)
      if (!pane) {
        this.closeStream(sid)
        this.send({ t: 'closed', sid, reason: 'pane closed', code: 'gone' })
        continue
      }
      if (pane.terminal_id !== s.terminalId) {
        // Live handoff assigns new terminal ids; reattach transparently.
        const { cols, rows } = s.stream
        this.closeStream(sid)
        const size = s.mode === 'mirror' ? nativeSize(this.sessionName, snapshot, pane) : { cols, rows }
        this.startStream(sid, pane, s.mode, size, false)
        continue
      }
      if (s.mode === 'mirror') {
        const size = nativeSize(this.sessionName, snapshot, pane)
        if (size.cols !== s.stream.cols || size.rows !== s.stream.rows) {
          s.stream.resize(size.cols, size.rows)
          this.send({ t: 'geometry', sid, ...size })
        }
      }
    }
  }

  private enqueue(paneId: string, job: Job) {
    if (!this.findPane(paneId)) return
    let q = this.queues.get(paneId)
    if (!q) {
      q = { jobs: [], running: false }
      this.queues.set(paneId, q)
    }
    // Coalesce runs of typing and wheel ticks into single requests.
    const last = q.jobs[q.jobs.length - 1]
    if (last?.kind === 'text' && job.kind === 'text') last.text += job.text
    else if (last?.kind === 'scroll' && job.kind === 'scroll') last.delta += job.delta
    else q.jobs.push(job)
    if (!q.running) void this.drain(paneId, q)
  }

  // Typing and keys go over RPC rather than a control stream so herdr encodes
  // logical keys for whatever keyboard protocol the pane's app negotiated.
  private async drain(paneId: string, q: { jobs: Job[]; running: boolean }) {
    q.running = true
    const sock = this.hub!.sock
    try {
      while (q.jobs.length && !this.closed) {
        const job = q.jobs.shift()!
        try {
          if (job.kind === 'text') {
            await rpc(sock, 'pane.send_text', { pane_id: paneId, text: job.text })
          } else if (job.kind === 'keys') {
            await rpc(sock, 'pane.send_keys', { pane_id: paneId, keys: job.keys })
          } else if (job.delta !== 0) {
            const { pane } = await rpc<{ pane: PaneInfo }>(sock, 'pane.get', { pane_id: paneId })
            const scroll = pane.scroll
            if (scroll) {
              const offset = Math.max(0, Math.min(scroll.max_offset_from_bottom, scroll.offset_from_bottom + job.delta))
              if (offset !== scroll.offset_from_bottom) {
                await rpc(sock, 'pane.scroll', { pane_id: paneId, offset_from_bottom: offset })
              }
            }
          }
        } catch (e) {
          const message = e instanceof HerdrError ? `${e.code}: ${e.message}` : String(e)
          this.send({ t: 'error', message: `input to ${paneId} failed (${message})` })
        }
      }
    } finally {
      q.running = false
    }
  }

  private async handleRpc(id: string, method: string, params: Record<string, unknown>) {
    if (!(ALLOWED_RPC as readonly string[]).includes(method) || !this.hub) {
      return this.send({ t: 'rpc', id, ok: false, error: { code: 'forbidden', message: `${method} not allowed` } })
    }
    try {
      const result = await rpc(this.hub.sock, method, params ?? {})
      this.send({ t: 'rpc', id, ok: true, result })
    } catch (e) {
      const err = e instanceof HerdrError ? { code: e.code, message: e.message } : { code: 'error', message: String(e) }
      this.send({ t: 'rpc', id, ok: false, error: err })
    }
    this.hub.scheduleRefresh(0)
  }

  private dispose() {
    if (this.closed) return
    this.closed = true
    connections.delete(this)
    clearInterval(this.sessionsTimer)
    for (const sid of [...this.streams.keys()]) this.closeStream(sid)
    this.unlisten?.()
  }
}
