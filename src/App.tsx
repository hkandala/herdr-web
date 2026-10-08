import type { PaneInfo } from '@shared/protocol'
import { Loader2, Plus, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DialogHost } from '@/components/dialogs'
import { createWorkspace, Sidebar } from '@/components/Sidebar'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceView, type ViewPrefs } from '@/components/WorkspaceView'
import { useBridge } from '@/lib/bridge'
import { workspacesOf } from '@/lib/herdr-ui'
import { cn } from '@/lib/utils'

const PREFS_KEY = 'herdr-web.prefs'
// Tabs kept mounted after you leave them, so returning doesn't reattach (and in
// Fit mode doesn't resize the panes back and forth under the herdr TUI).
const MAX_ALIVE_TABS = 8

function loadPrefs(): ViewPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { mode: p.mode === 'control' ? 'control' : 'mirror', fontSize: Number(p.fontSize) || 13 }
  } catch {
    return { mode: 'mirror', fontSize: 13 }
  }
}

export default function App() {
  const { session } = useBridge()
  // Keyed so all per-session selection state resets when switching sessions.
  return <Shell key={session ?? ''} />
}

function Shell() {
  const { snapshot, error, connected, session, notice } = useBridge()
  const [prefs, setPrefs] = useState(loadPrefs)
  // Selection is local to this browser; it deliberately doesn't move herdr's own focus.
  const [workspaceSel, setWorkspaceSel] = useState<string | null>(null)
  const [tabSel, setTabSel] = useState<Record<string, string>>({})
  const [paneSel, setPaneSel] = useState<Record<string, string>>({})
  const [zoomSel, setZoomSel] = useState<Record<string, string | null>>({})
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs])

  const workspaces = snapshot ? workspacesOf(snapshot) : []
  const workspace =
    workspaces.find((w) => w.workspace_id === workspaceSel) ??
    workspaces.find((w) => w.workspace_id === snapshot?.focused_workspace_id) ??
    workspaces[0] ??
    null
  const tabId = workspace ? tabSel[workspace.workspace_id] : undefined
  const tab =
    (workspace && snapshot?.tabs.find((t) => t.tab_id === tabId && t.workspace_id === workspace.workspace_id)) ||
    (workspace && snapshot?.tabs.find((t) => t.tab_id === workspace.active_tab_id)) ||
    (workspace && snapshot?.tabs.find((t) => t.workspace_id === workspace.workspace_id)) ||
    null
  const activePaneId = tab ? (paneSel[tab.tab_id] ?? null) : null

  // Most-recently-viewed first. Adjusted during render so the new tab mounts in
  // the same pass that selects it.
  const [alive, setAlive] = useState<string[]>([])
  if (tab && alive[0] !== tab.tab_id) {
    setAlive([tab.tab_id, ...alive.filter((id) => id !== tab.tab_id)].slice(0, MAX_ALIVE_TABS))
  }
  const aliveTabs = snapshot ? alive.flatMap((id) => snapshot.tabs.filter((t) => t.tab_id === id)) : []

  const jumpToPane = (p: PaneInfo) => {
    setWorkspaceSel(p.workspace_id)
    setTabSel((s) => ({ ...s, [p.workspace_id]: p.tab_id }))
    setPaneSel((s) => ({ ...s, [p.tab_id]: p.pane_id }))
    setZoomSel((s) => (s[p.tab_id] && s[p.tab_id] !== p.pane_id ? { ...s, [p.tab_id]: p.pane_id } : s))
    setSidebarOpen(false)
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-dvh w-full overflow-hidden bg-[#09090b] text-neutral-200">
        <div
          className={cn(
            'fixed inset-y-0 left-0 z-40 transition-transform md:static md:translate-x-0',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar
            snapshot={snapshot}
            workspaceId={workspace?.workspace_id ?? null}
            activePaneId={activePaneId}
            onSelectWorkspace={(id) => {
              setWorkspaceSel(id)
              setSidebarOpen(false)
            }}
            onJumpToPane={jumpToPane}
          />
        </div>
        {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />}

        {snapshot && workspace ? (
          <WorkspaceView
            snapshot={snapshot}
            workspace={workspace}
            tab={tab}
            aliveTabs={aliveTabs}
            paneSel={paneSel}
            zoomSel={zoomSel}
            prefs={prefs}
            onPrefs={setPrefs}
            onSelectTab={(id) => setTabSel((s) => ({ ...s, [workspace.workspace_id]: id }))}
            onActivatePane={(tabId, id) => setPaneSel((s) => ({ ...s, [tabId]: id }))}
            onZoomPane={(tabId, id) => {
              setZoomSel((s) => ({ ...s, [tabId]: id }))
              if (id) setPaneSel((s) => ({ ...s, [tabId]: id }))
            }}
            onToggleSidebar={() => setSidebarOpen((o) => !o)}
          />
        ) : (
          <EmptyState
            connected={connected}
            loading={connected && !snapshot && !error}
            error={error}
            session={session}
            noWorkspaces={Boolean(snapshot && workspaces.length === 0)}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        )}
      </div>
      <DialogHost />
      {notice && (
        <div className="fixed right-4 bottom-4 z-50 max-w-sm rounded-lg bg-neutral-900 px-3 py-2 text-xs text-neutral-300 shadow-lg ring-1 ring-white/10">
          {notice.message}
        </div>
      )}
    </TooltipProvider>
  )
}

function EmptyState(props: {
  connected: boolean
  loading: boolean
  error: string | null
  session: string | null
  noWorkspaces: boolean
  onOpenSidebar: () => void
}) {
  let body: React.ReactNode
  if (!props.connected) {
    body = (
      <>
        <Loader2 className="size-4 animate-spin text-neutral-500" />
        <p>Connecting to the herdr-web bridge…</p>
      </>
    )
  } else if (props.loading) {
    body = (
      <>
        <Loader2 className="size-4 animate-spin text-neutral-500" />
        <p>Loading session…</p>
      </>
    )
  } else if (props.error) {
    body = (
      <>
        <TriangleAlert className="size-4 text-amber-400" />
        <p className="text-neutral-300">Can’t reach herdr session “{props.session}”.</p>
        <p className="max-w-sm font-mono text-[11px] text-neutral-600">{props.error}</p>
        <p className="text-xs text-neutral-500">
          Start it with <code className="rounded bg-white/5 px-1 py-0.5 font-mono">herdr{props.session && props.session !== 'default' ? ` --session ${props.session}` : ''}</code>{' '}
          or pick another session.
        </p>
        <Button size="sm" variant="outline" className="md:hidden" onClick={props.onOpenSidebar}>
          Sessions
        </Button>
      </>
    )
  } else if (props.noWorkspaces) {
    body = (
      <>
        <p className="text-neutral-400">This session has no workspaces yet.</p>
        <Button size="sm" variant="outline" onClick={() => void createWorkspace()}>
          <Plus /> New workspace
        </Button>
      </>
    )
  }
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-neutral-500">{body}</div>
}
