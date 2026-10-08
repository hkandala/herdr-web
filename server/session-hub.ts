// One hub per herdr session, shared by every browser looking at it. It keeps the
// latest session.snapshot and pushes a fresh one whenever herdr reports a change.
//
// Change detection:
// - a structural subscription (workspace/tab/pane/layout events) on one connection,
// - per-pane `pane.agent_status_changed` on a second connection; herdr rejects the
//   whole subscribe if any pane id is unknown, and ignores a second subscribe on an
//   open connection, so it is rebuilt whenever the pane set changes,
// - a slow poll as a backstop for things that emit no event (terminal titles, cwd).

import type { SessionSnapshot } from '../shared/protocol.ts'
import { rpc, socketPath, subscribe, type Subscription } from './herdr.ts'

const STRUCTURAL = [
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'workspace.focused',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated',
].map((type) => ({ type }))

const POLL_MS = 2500
const REFRESH_DEBOUNCE_MS = 40

type Listener = (snapshot: SessionSnapshot | null, error?: string) => void

export class SessionHub {
  readonly name: string
  readonly sock: string
  snapshot: SessionSnapshot | null = null
  error: string | undefined

  private listeners = new Set<Listener>()
  private structural: Subscription | null = null
  private status: Subscription | null = null
  private statusPaneKey = ''
  private pollTimer: NodeJS.Timeout | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoff = 250
  private refreshing = false
  private refreshAgain = false
  private lastJson = ''
  private stopped = true

  constructor(name: string) {
    this.name = name
    this.sock = socketPath(name)
  }

  addListener(fn: Listener): () => void {
    this.listeners.add(fn)
    if (this.stopped) this.start()
    else if (this.snapshot || this.error) fn(this.snapshot, this.error)
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** Coalesces bursts of events into a single snapshot fetch. */
  scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
    if (this.stopped || this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, delay)
  }

  private start() {
    this.stopped = false
    this.connectStructural()
    void this.refresh()
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS)
  }

  private stop() {
    this.stopped = true
    this.structural?.close()
    this.status?.close()
    this.structural = this.status = null
    this.statusPaneKey = ''
    for (const t of [this.pollTimer, this.refreshTimer, this.reconnectTimer]) if (t) clearTimeout(t)
    this.pollTimer = this.refreshTimer = this.reconnectTimer = null
    this.snapshot = null
    this.error = undefined
    this.lastJson = ''
  }

  private connectStructural() {
    if (this.stopped) return
    this.structural = subscribe(
      this.sock,
      STRUCTURAL,
      () => {
        this.backoff = 250
        this.scheduleRefresh()
      },
      () => {
        this.structural = null
        if (this.stopped) return
        // Herdr drops slow subscribers and restarts during handoff; reconnect
        // and take a snapshot to catch anything missed.
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          this.connectStructural()
          this.scheduleRefresh()
        }, this.backoff)
        this.backoff = Math.min(this.backoff * 2, 5000)
      },
    )
  }

  private syncStatusSubscription(snapshot: SessionSnapshot) {
    const ids = snapshot.panes.map((p) => p.pane_id).sort()
    const key = ids.join(',')
    if (key === this.statusPaneKey && this.status) return
    this.status?.close()
    this.status = null
    this.statusPaneKey = key
    if (ids.length === 0) return
    const sub = subscribe(
      this.sock,
      ids.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
      () => this.scheduleRefresh(),
      () => {
        if (this.status === sub) {
          this.status = null
          // Let the next snapshot rebuild it.
          this.statusPaneKey = ''
        }
      },
    )
    this.status = sub
  }

  private async refresh() {
    if (this.stopped) return
    if (this.refreshing) {
      this.refreshAgain = true
      return
    }
    this.refreshing = true
    try {
      const result = await rpc<{ snapshot: SessionSnapshot }>(this.sock, 'session.snapshot')
      if (this.stopped) return
      const snapshot = result.snapshot
      this.error = undefined
      this.syncStatusSubscription(snapshot)
      const json = JSON.stringify(snapshot)
      if (json !== this.lastJson) {
        this.lastJson = json
        this.snapshot = snapshot
        this.emit()
      }
    } catch (e) {
      if (this.stopped) return
      const message = e instanceof Error ? e.message : String(e)
      if (this.error !== message || this.snapshot) {
        this.error = message
        this.snapshot = null
        this.lastJson = ''
        this.emit()
      }
    } finally {
      this.refreshing = false
      if (this.refreshAgain) {
        this.refreshAgain = false
        this.scheduleRefresh(0)
      }
    }
  }

  private emit() {
    for (const fn of this.listeners) fn(this.snapshot, this.error)
  }
}

const hubs = new Map<string, SessionHub>()

export function getHub(name: string): SessionHub {
  let hub = hubs.get(name)
  if (!hub) {
    hub = new SessionHub(name)
    hubs.set(name, hub)
  }
  return hub
}
