import type { PaneInfo, SessionSnapshot, StreamMode, TabInfo, WorkspaceInfo } from '@shared/protocol'
import {
  Columns2,
  Maximize2,
  Menu,
  Minimize2,
  Minus,
  Pencil,
  MonitorSmartphone,
  MoreHorizontal,
  Plus,
  Rows2,
  ScanEye,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { act } from '@/lib/bridge'
import { paneAgent, paneTitle, shortPath, tabsOf } from '@/lib/herdr-ui'
import { cn } from '@/lib/utils'
import { confirmDialog, promptDialog } from './dialogs'
import { StatusDot } from './StatusDot'
import { TerminalView } from './TerminalView'

export interface ViewPrefs {
  mode: StreamMode
  fontSize: number
}

interface Props {
  snapshot: SessionSnapshot
  workspace: WorkspaceInfo
  tab: TabInfo | null
  /** Recently viewed tabs (any workspace) kept mounted so switching back doesn't reattach. */
  aliveTabs: TabInfo[]
  paneSel: Record<string, string>
  zoomSel: Record<string, string | null>
  prefs: ViewPrefs
  onPrefs: (p: ViewPrefs) => void
  onSelectTab: (tabId: string) => void
  onActivatePane: (tabId: string, paneId: string) => void
  onZoomPane: (tabId: string, paneId: string | null) => void
  onToggleSidebar: () => void
}

export function WorkspaceView(props: Props) {
  const { snapshot, workspace, tab, prefs, onPrefs, onToggleSidebar } = props
  const tabs = tabsOf(snapshot, workspace.workspace_id)

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onToggleSidebar}>
          <Menu />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((t) => (
            <TabButton key={t.tab_id} tab={t} active={t.tab_id === tab?.tab_id} onSelect={props.onSelectTab} />
          ))}
          <Button
            variant="ghost"
            size="icon-xs"
            title="New tab"
            className="ml-1 text-neutral-500"
            onClick={async () => {
              const res = await act<{ tab: TabInfo }>('tab.create', { workspace_id: workspace.workspace_id, focus: false })
              if (res?.tab) props.onSelectTab(res.tab.tab_id)
            }}
          >
            <Plus />
          </Button>
        </div>
        <ModeToggle prefs={prefs} onPrefs={onPrefs} />
      </header>
      <div className="relative min-h-0 flex-1">
        {props.aliveTabs.map((t) => (
          <PaneArea
            key={t.tab_id}
            snapshot={snapshot}
            tab={t}
            visible={t.tab_id === tab?.tab_id}
            activePaneId={props.paneSel[t.tab_id] ?? null}
            zoomedPaneId={props.zoomSel[t.tab_id] ?? null}
            prefs={prefs}
            onActivatePane={props.onActivatePane}
            onZoomPane={props.onZoomPane}
          />
        ))}
        {!tab && <div className="grid h-full place-items-center text-sm text-neutral-600">No tab selected.</div>}
      </div>
    </div>
  )
}

function TabButton({ tab, active, onSelect }: { tab: TabInfo; active: boolean; onSelect: (id: string) => void }) {
  const rename = async () => {
    const v = await promptDialog({ title: 'Rename tab', fields: [{ name: 'label', label: 'Name', value: tab.label }] })
    if (v?.label.trim()) await act('tab.rename', { tab_id: tab.tab_id, label: v.label.trim() })
  }
  const close = async () => {
    const ok = await confirmDialog({
      title: `Close tab “${tab.label}”?`,
      description: `${tab.pane_count} pane${tab.pane_count === 1 ? '' : 's'} and their processes will be terminated.`,
      confirmLabel: 'Close tab',
      destructive: true,
    })
    if (ok) await act('tab.close', { tab_id: tab.tab_id })
  }
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(tab.tab_id)}
      onDoubleClick={rename}
      className={cn(
        'group flex h-7 shrink-0 cursor-default items-center gap-2 rounded-md pr-1 pl-2.5 text-[12.5px] text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300',
        active && 'bg-white/[0.07] text-neutral-100 hover:bg-white/[0.07] hover:text-neutral-100',
      )}
    >
      <StatusDot status={tab.agent_status} />
      <span className="max-w-40 truncate">{tab.label}</span>
      <button
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          void close()
        }}
        className="grid size-4 place-items-center rounded text-neutral-600 opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-neutral-300 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function ModeToggle({ prefs, onPrefs }: { prefs: ViewPrefs; onPrefs: (p: ViewPrefs) => void }) {
  const option = (mode: StreamMode, icon: React.ReactNode, label: string, hint: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            onClick={() => onPrefs({ ...prefs, mode })}
            className={cn(
              'flex h-6 items-center gap-1.5 rounded px-2 text-[11.5px] text-neutral-500 hover:text-neutral-300',
              prefs.mode === mode && 'bg-white/[0.08] text-neutral-100 hover:text-neutral-100',
            )}
          >
            {icon}
            <span className="hidden sm:inline">{label}</span>
          </button>
        }
      />
      <TooltipContent side="bottom" className="max-w-64">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
  return (
    <div className="flex shrink-0 items-center gap-1">
      {prefs.mode === 'control' && (
        <div className="mr-1 flex items-center text-neutral-500">
          <Button variant="ghost" size="icon-xs" title="Smaller text" onClick={() => onPrefs({ ...prefs, fontSize: Math.max(8, prefs.fontSize - 1) })}>
            <Minus />
          </Button>
          <span className="w-6 text-center font-mono text-[11px]">{prefs.fontSize}</span>
          <Button variant="ghost" size="icon-xs" title="Larger text" onClick={() => onPrefs({ ...prefs, fontSize: Math.min(24, prefs.fontSize + 1) })}>
            <Plus />
          </Button>
        </div>
      )}
      <div className="flex items-center rounded-md bg-white/[0.03] p-0.5 ring-1 ring-white/[0.06]">
        {option(
          'mirror',
          <ScanEye className="size-3.5" />,
          'Mirror',
          'Show panes exactly as herdr lays them out, at their real size. Never resizes anything, so it is safe alongside the herdr TUI.',
        )}
        {option(
          'control',
          <MonitorSmartphone className="size-3.5" />,
          'Fit',
          'Same layout, but each pane attaches as herdr’s controller and is resized to its box here. Changes those panes’ size for the herdr TUI too.',
        )}
      </div>
    </div>
  )
}

interface PaneAreaProps {
  snapshot: SessionSnapshot
  tab: TabInfo
  visible: boolean
  activePaneId: string | null
  zoomedPaneId: string | null
  prefs: ViewPrefs
  onActivatePane: (tabId: string, paneId: string) => void
  onZoomPane: (tabId: string, paneId: string | null) => void
}

// Mirror and Fit share this layout; they differ only in how each TerminalView
// attaches. Panes are never unmounted for zoom: the zoomed pane's box grows and
// the others are hidden, so Fit-mode attachments (and their sizes) survive.
function PaneArea({ snapshot, tab, visible, activePaneId, zoomedPaneId, prefs, onActivatePane, onZoomPane }: PaneAreaProps) {
  const layout = snapshot.layouts.find((l) => l.tab_id === tab.tab_id)
  const panes = snapshot.panes.filter((p) => p.tab_id === tab.tab_id)
  const byId = new Map(panes.map((p) => [p.pane_id, p]))
  const active = (activePaneId && byId.get(activePaneId)) || byId.get(layout?.focused_pane_id ?? '') || panes[0]
  const zoomed = zoomedPaneId && byId.has(zoomedPaneId) ? zoomedPaneId : null
  const area = layout?.area
  const order = layout?.panes ?? panes.map((p) => ({ pane_id: p.pane_id, rect: null }))

  return (
    <div className={cn('absolute inset-0 p-1.5', !visible && 'invisible')} aria-hidden={!visible}>
      {!active ? (
        <div className="grid h-full place-items-center text-sm text-neutral-600">This tab has no panes.</div>
      ) : (
        <div className="relative h-full w-full">
          {order.map((lp) => {
            const pane = byId.get(lp.pane_id)
            if (!pane) return null
            const isZoomed = zoomed === pane.pane_id
            const style =
              !zoomed && lp.rect && area
                ? {
                    left: `${((lp.rect.x - area.x) / area.width) * 100}%`,
                    top: `${((lp.rect.y - area.y) / area.height) * 100}%`,
                    width: `${(lp.rect.width / area.width) * 100}%`,
                    height: `${(lp.rect.height / area.height) * 100}%`,
                  }
                : { inset: 0 }
            return (
              <div
                key={pane.pane_id}
                className={cn('absolute p-[3px]', zoomed && !isZoomed && 'invisible')}
                style={style}
              >
                <PaneFrame
                  pane={pane}
                  prefs={prefs}
                  active={visible && pane.pane_id === active.pane_id}
                  zoomed={isZoomed}
                  canZoom={panes.length > 1}
                  onActivate={() => onActivatePane(tab.tab_id, pane.pane_id)}
                  onZoom={() => onZoomPane(tab.tab_id, isZoomed ? null : pane.pane_id)}
                  className="h-full"
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface FrameProps {
  pane: PaneInfo
  prefs: ViewPrefs
  active: boolean
  zoomed: boolean
  canZoom: boolean
  onActivate: () => void
  onZoom: () => void
  className?: string
}

function PaneFrame({ pane, prefs, active, zoomed, canZoom, onActivate, onZoom, className }: FrameProps) {
  const agent = paneAgent(pane)
  const split = (direction: 'right' | 'down') =>
    act('pane.split', {
      target_pane_id: pane.pane_id,
      direction,
      focus: false,
      cwd: pane.foreground_cwd || pane.cwd || undefined,
    })
  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-lg bg-[#0c0c0d] ring-1 ring-white/[0.06] transition-shadow',
        active && 'ring-white/[0.16]',
        className,
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-white/[0.05] pr-1 pl-2.5 text-[11.5px]">
        <StatusDot status={pane.agent_status} />
        {agent && <span className="font-medium text-neutral-300">{agent}</span>}
        <span className="min-w-0 truncate text-neutral-500">
          {paneTitle(pane) !== agent ? paneTitle(pane) : ''}
          <span className="ml-2 text-neutral-700">{shortPath(pane.foreground_cwd || pane.cwd)}</span>
        </span>
        <div className="ml-auto flex items-center">
          {canZoom && (
            <Button variant="ghost" size="icon-xs" className="text-neutral-500" title={zoomed ? 'Restore layout' : 'Maximize'} onClick={onZoom}>
              {zoomed ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" className="text-neutral-500">
                  <MoreHorizontal />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => split('right')}>
                <Columns2 /> Split right
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => split('down')}>
                <Rows2 /> Split down
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const v = await promptDialog({
                    title: 'Rename pane',
                    description: 'Leave empty to clear the custom name.',
                    fields: [{ name: 'label', label: 'Name', value: pane.label ?? '' }],
                  })
                  if (v) await act('pane.rename', { pane_id: pane.pane_id, label: v.label.trim() || null })
                }}
              >
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: 'Close pane?',
                    description: `${agent ? `The ${agent} session` : 'The process'} running in this pane will be terminated.`,
                    confirmLabel: 'Close pane',
                    destructive: true,
                  })
                  if (ok) await act('pane.close', { pane_id: pane.pane_id })
                }}
              >
                <X /> Close pane
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-1">
        <TerminalView
          paneId={pane.pane_id}
          mode={prefs.mode}
          fontSize={prefs.fontSize}
          bracketedPaste={Boolean(agent)}
          active={active}
          onActivate={onActivate}
        />
      </div>
    </div>
  )
}
