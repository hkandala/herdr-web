import type { AgentStatus, PaneInfo, SessionSnapshot } from '@shared/protocol'

export function basename(p?: string | null): string {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export function shortPath(p?: string | null): string {
  if (!p) return ''
  return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~')
}

export function paneTitle(p: PaneInfo): string {
  return (
    p.label ||
    p.terminal_title_stripped ||
    p.title ||
    p.display_agent ||
    p.agent ||
    basename(p.foreground_cwd || p.cwd) ||
    p.pane_id
  )
}

export function paneAgent(p: PaneInfo): string | null {
  return p.display_agent || p.agent || null
}

const STATUS_RANK: Record<AgentStatus, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 }

export function byStatus(a: { agent_status: AgentStatus }, b: { agent_status: AgentStatus }) {
  return STATUS_RANK[a.agent_status] - STATUS_RANK[b.agent_status]
}

export function tabsOf(s: SessionSnapshot, workspaceId: string) {
  return s.tabs.filter((t) => t.workspace_id === workspaceId).sort((a, b) => a.number - b.number)
}

export function workspacesOf(s: SessionSnapshot) {
  return [...s.workspaces].sort((a, b) => a.number - b.number)
}
