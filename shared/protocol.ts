// Wire types shared by the Node bridge (server/) and the browser (src/).
// Herdr shapes mirror `herdr api schema --json` (protocol 22).

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkspaceInfo {
  workspace_id: string
  number: number
  label: string
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id: string
  agent_status: AgentStatus
  worktree?: { branch?: string | null } | null
}

export interface TabInfo {
  tab_id: string
  workspace_id: string
  number: number
  label: string
  focused: boolean
  pane_count: number
  agent_status: AgentStatus
}

export interface PaneScrollInfo {
  offset_from_bottom: number
  max_offset_from_bottom: number
  viewport_rows: number
}

export interface PaneInfo {
  pane_id: string
  terminal_id: string
  workspace_id: string
  tab_id: string
  focused: boolean
  agent_status: AgentStatus
  revision: number
  agent?: string | null
  display_agent?: string | null
  cwd?: string | null
  foreground_cwd?: string | null
  label?: string | null
  title?: string | null
  terminal_title?: string | null
  terminal_title_stripped?: string | null
  restore_error?: string | null
  scroll?: PaneScrollInfo | null
}

export interface PaneLayoutSnapshot {
  workspace_id: string
  tab_id: string
  zoomed: boolean
  area: Rect
  focused_pane_id: string
  panes: { pane_id: string; focused: boolean; rect: Rect }[]
  splits: { id: string; direction: 'right' | 'down'; ratio: number; rect: Rect }[]
}

export interface SessionSnapshot {
  version: string
  protocol: number
  focused_workspace_id?: string | null
  focused_tab_id?: string | null
  focused_pane_id?: string | null
  workspaces: WorkspaceInfo[]
  tabs: TabInfo[]
  panes: PaneInfo[]
  layouts: PaneLayoutSnapshot[]
}

export interface SessionEntry {
  name: string
  running: boolean
}

export type StreamMode = 'mirror' | 'control'
export type MouseAction = 'down' | 'up' | 'drag' | 'move'
export type MouseButton = 'left' | 'right' | 'middle'

/** RPC methods the browser may invoke through the bridge. */
export const ALLOWED_RPC = [
  'workspace.create',
  'workspace.rename',
  'workspace.close',
  'tab.create',
  'tab.rename',
  'tab.close',
  'pane.split',
  'pane.close',
  'pane.rename',
  'pane.zoom',
] as const
export type AllowedRpc = (typeof ALLOWED_RPC)[number]

export type ClientMsg =
  /** Switch the herdr session this connection is looking at. */
  | { t: 'session'; name: string }
  /** Start streaming a pane into the view identified by `sid`. */
  | {
      t: 'open'
      sid: string
      paneId: string
      mode: StreamMode
      cols?: number
      rows?: number
      takeover?: boolean
    }
  | { t: 'close'; sid: string }
  /** Control mode only: resize the herdr terminal. */
  | { t: 'resize'; sid: string; cols: number; rows: number }
  /** Raw text goes through pane.send_text; logical keys through pane.send_keys. */
  | { t: 'input'; paneId: string; text?: string; keys?: string[] }
  | { t: 'scroll'; sid: string; direction: 'up' | 'down'; lines: number }
  /**
   * Control mode only. 0-based cell coordinates; modifiers are crossterm bits
   * (1 shift, 2 ctrl, 4 alt). Herdr encodes it for the app's mouse mode.
   */
  | {
      t: 'mouse'
      sid: string
      action: MouseAction
      button?: MouseButton
      column: number
      row: number
      modifiers: number
    }
  | { t: 'rpc'; id: string; method: AllowedRpc; params: Record<string, unknown> }

export type ServerMsg =
  | { t: 'hello'; sessions: SessionEntry[]; session: string }
  | { t: 'sessions'; sessions: SessionEntry[] }
  | { t: 'snapshot'; session: string; snapshot: SessionSnapshot | null; error?: string }
  /** `data` is base64-encoded ANSI exactly as herdr produced it. */
  | { t: 'frame'; sid: string; full: boolean; cols: number; rows: number; data: string }
  | { t: 'geometry'; sid: string; cols: number; rows: number }
  | { t: 'closed'; sid: string; reason: string; code?: 'held' | 'gone' | 'error' }
  | { t: 'rpc'; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  | { t: 'error'; message: string }
