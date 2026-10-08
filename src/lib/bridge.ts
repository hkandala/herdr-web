// Browser side of the /ws bridge: connection state for React, per-view stream
// handlers, and request/response RPC.

import { useSyncExternalStore } from 'react'
import type {
  AllowedRpc,
  ClientMsg,
  MouseAction,
  MouseButton,
  ServerMsg,
  SessionEntry,
  SessionSnapshot,
  StreamMode,
} from '@shared/protocol'

export type StreamEvent = Extract<ServerMsg, { t: 'frame' | 'geometry' | 'closed' }>

export interface BridgeState {
  connected: boolean
  sessions: SessionEntry[]
  session: string | null
  snapshot: SessionSnapshot | null
  error: string | null
  /** Transient notices (failed input, rpc errors) for the toast area. */
  notice: { id: number; message: string } | null
}

interface StreamSpec {
  paneId: string
  mode: StreamMode
  cols?: number
  rows?: number
  takeover?: boolean
  onEvent: (e: StreamEvent) => void
}

const SESSION_KEY = 'herdr-web.session'

class Bridge {
  state: BridgeState = {
    connected: false,
    sessions: [],
    session: null,
    snapshot: null,
    error: null,
    notice: null,
  }
  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private streams = new Map<string, StreamSpec>()
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private backoff = 250
  private nextId = 0
  // Streams must be (re)opened only once the server holds a snapshot for the
  // current session, otherwise it can't resolve the pane.
  private ready = false

  constructor() {
    this.connect()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getState = () => this.state

  private set(patch: Partial<BridgeState>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params = new URLSearchParams(location.search)
    const session = params.get('session') ?? localStorage.getItem(SESSION_KEY)
    const ws = new WebSocket(`${proto}://${location.host}/ws${session ? `?session=${encodeURIComponent(session)}` : ''}`)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 250
      this.set({ connected: true })
    }
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMsg)
    ws.onclose = () => {
      this.ws = null
      this.ready = false
      for (const p of this.pending.values()) p.reject(new Error('disconnected'))
      this.pending.clear()
      this.set({ connected: false })
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 5000)
    }
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 'hello':
        this.ready = false
        this.set({ sessions: msg.sessions, session: msg.session, snapshot: null, error: null })
        break
      case 'sessions':
        this.set({ sessions: msg.sessions })
        break
      case 'snapshot':
        if (msg.session !== this.state.session) return
        this.set({ snapshot: msg.snapshot, error: msg.error ?? null })
        if (msg.snapshot && !this.ready) {
          this.ready = true
          for (const [sid, spec] of this.streams) this.sendOpen(sid, spec)
        }
        break
      case 'frame':
      case 'geometry':
      case 'closed':
        this.streams.get(msg.sid)?.onEvent(msg)
        if (msg.t === 'closed') this.streams.delete(msg.sid)
        break
      case 'rpc': {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error?.message ?? 'request failed'))
        break
      }
      case 'error':
        this.notify(msg.message)
        break
    }
  }

  notify(message: string) {
    this.set({ notice: { id: Date.now(), message } })
  }

  selectSession(name: string) {
    if (name === this.state.session) return
    localStorage.setItem(SESSION_KEY, name)
    const url = new URL(location.href)
    url.searchParams.delete('session')
    history.replaceState(null, '', url)
    this.ready = false
    this.streams.clear()
    this.set({ session: name, snapshot: null, error: null })
    this.send({ t: 'session', name })
  }

  private sendOpen(sid: string, spec: StreamSpec) {
    const { paneId, mode, cols, rows, takeover } = spec
    this.send({ t: 'open', sid, paneId, mode, cols, rows, takeover })
    // Takeover is a one-shot request; reconnects must not repeat it.
    spec.takeover = false
  }

  openStream(spec: StreamSpec): string {
    const sid = `v${++this.nextId}`
    this.streams.set(sid, spec)
    if (this.ready) this.sendOpen(sid, spec)
    return sid
  }

  closeStream(sid: string) {
    if (this.streams.delete(sid)) this.send({ t: 'close', sid })
  }

  resizeStream(sid: string, cols: number, rows: number) {
    const spec = this.streams.get(sid)
    if (!spec) return
    spec.cols = cols
    spec.rows = rows
    this.send({ t: 'resize', sid, cols, rows })
  }

  scroll(sid: string, direction: 'up' | 'down', lines: number) {
    this.send({ t: 'scroll', sid, direction, lines })
  }

  mouse(sid: string, action: MouseAction, button: MouseButton | undefined, column: number, row: number, modifiers: number) {
    this.send({ t: 'mouse', sid, action, button, column, row, modifiers })
  }

  sendText(paneId: string, text: string) {
    this.send({ t: 'input', paneId, text })
  }

  sendKeys(paneId: string, keys: string[]) {
    this.send({ t: 'input', paneId, keys })
  }

  rpc<T = unknown>(method: AllowedRpc, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('not connected'))
      const id = `r${++this.nextId}`
      this.pending.set(id, { resolve, reject })
      this.send({ t: 'rpc', id, method, params })
    })
  }
}

export const bridge = new Bridge()

export function useBridge(): BridgeState {
  return useSyncExternalStore(bridge.subscribe, bridge.getState)
}

/** Runs an RPC and surfaces failures as a notice instead of throwing. */
export async function act<T = unknown>(method: AllowedRpc, params: Record<string, unknown>): Promise<T | null> {
  try {
    return await bridge.rpc<T>(method, params)
  } catch (e) {
    bridge.notify(`${method}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
