import type { PaneInfo, SessionSnapshot } from '@shared/protocol'
import { Check, ChevronsUpDown, MoreHorizontal, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { act, bridge, useBridge } from '@/lib/bridge'
import { byStatus, paneAgent, paneTitle, shortPath, workspacesOf } from '@/lib/herdr-ui'
import { cn } from '@/lib/utils'
import { confirmDialog, promptDialog } from './dialogs'
import { StatusDot } from './StatusDot'

interface Props {
  snapshot: SessionSnapshot | null
  workspaceId: string | null
  activePaneId: string | null
  onSelectWorkspace: (id: string) => void
  onJumpToPane: (pane: PaneInfo) => void
}

export async function createWorkspace() {
  const values = await promptDialog({
    title: 'New workspace',
    confirmLabel: 'Create',
    fields: [
      { name: 'label', label: 'Name', placeholder: 'optional' },
      { name: 'cwd', label: 'Directory', placeholder: '~/code/project (optional)' },
    ],
  })
  if (!values) return null
  const params: Record<string, unknown> = { focus: false }
  if (values.label.trim()) params.label = values.label.trim()
  if (values.cwd.trim()) params.cwd = values.cwd.trim()
  return act<{ workspace: { workspace_id: string } }>('workspace.create', params)
}

export function Sidebar({ snapshot, workspaceId, activePaneId, onSelectWorkspace, onJumpToPane }: Props) {
  const { sessions, session, connected } = useBridge()
  const workspaces = snapshot ? workspacesOf(snapshot) : []
  const agents = snapshot ? snapshot.panes.filter((p) => paneAgent(p)).sort(byStatus) : []
  const tabLabel = (tabId: string) => snapshot?.tabs.find((t) => t.tab_id === tabId)?.label ?? ''
  const wsLabel = (id: string) => snapshot?.workspaces.find((w) => w.workspace_id === id)?.label ?? id

  const onNewWorkspace = async () => {
    const res = await createWorkspace()
    if (res?.workspace) onSelectWorkspace(res.workspace.workspace_id)
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-white/[0.06] bg-[#0e0e10]">
      <div className="flex h-11 items-center gap-2 px-3">
        <span className="font-mono text-[13px] font-semibold tracking-tight text-neutral-200">herdr</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="xs" className="ml-auto max-w-36 gap-1 text-neutral-400">
                <span className="truncate">{session ?? '…'}</span>
                <ChevronsUpDown className="size-3 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="dark w-52">
            <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider">Sessions</DropdownMenuLabel>
            {sessions.map((s) => (
              <DropdownMenuItem key={s.name} onClick={() => bridge.selectSession(s.name)} className="gap-2">
                <span className={cn('size-1.5 rounded-full', s.running ? 'bg-emerald-400' : 'bg-neutral-700')} />
                <span className={cn('truncate', !s.running && 'text-muted-foreground')}>{s.name}</span>
                {s.name === session && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SectionHeader label="Workspaces">
          <Button variant="ghost" size="icon-xs" title="New workspace" onClick={onNewWorkspace} disabled={!snapshot}>
            <Plus />
          </Button>
        </SectionHeader>
        <nav className="grid gap-px">
          {workspaces.map((w) => (
            <div
              key={w.workspace_id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectWorkspace(w.workspace_id)}
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onSelectWorkspace(w.workspace_id)}
              className={cn(
                'group flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] text-neutral-400 outline-none hover:bg-white/[0.04] hover:text-neutral-200',
                w.workspace_id === workspaceId && 'bg-white/[0.07] text-neutral-100',
              )}
            >
              <StatusDot status={w.agent_status} />
              <span className="truncate">{w.label}</span>
              {w.worktree?.branch && (
                <span className="truncate font-mono text-[10px] text-neutral-600">{w.worktree.branch}</span>
              )}
              <span className="ml-auto font-mono text-[10px] text-neutral-600 group-hover:hidden">{w.tab_count}</span>
              <WorkspaceMenu id={w.workspace_id} label={w.label} />
            </div>
          ))}
          {snapshot && workspaces.length === 0 && (
            <p className="px-2 py-1 text-xs text-neutral-600">No workspaces.</p>
          )}
        </nav>

        {agents.length > 0 && (
          <>
            <SectionHeader label="Agents" />
            <div className="grid gap-px">
              {agents.map((p) => (
                <button
                  key={p.pane_id}
                  onClick={() => onJumpToPane(p)}
                  className={cn(
                    'flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.04]',
                    p.pane_id === activePaneId && 'bg-white/[0.05]',
                  )}
                >
                  <span className="flex w-full items-center gap-2 text-[12px] text-neutral-300">
                    <StatusDot status={p.agent_status} />
                    <span className="font-medium">{paneAgent(p)}</span>
                    <span className="ml-auto truncate text-[10px] text-neutral-600">
                      {wsLabel(p.workspace_id)} / {tabLabel(p.tab_id)}
                    </span>
                  </span>
                  <span className="w-full truncate pl-3.5 text-[11px] text-neutral-500">
                    {paneTitle(p) !== paneAgent(p) ? paneTitle(p) : shortPath(p.foreground_cwd || p.cwd)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex h-8 items-center gap-2 border-t border-white/[0.06] px-3 text-[11px] text-neutral-600">
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse')} />
        {connected ? (snapshot ? `herdr ${snapshot.version}` : 'connected') : 'reconnecting…'}
      </div>
    </aside>
  )
}

function SectionHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="mt-3 mb-1 flex h-6 items-center px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-600">
      {label}
      <span className="ml-auto">{children}</span>
    </div>
  )
}

function WorkspaceMenu({ id, label }: { id: string; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        render={
          <Button variant="ghost" size="icon-xs" className="ml-auto hidden group-hover:inline-flex aria-expanded:inline-flex">
            <MoreHorizontal />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="dark w-40" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onClick={async () => {
            const v = await promptDialog({ title: 'Rename workspace', fields: [{ name: 'label', label: 'Name', value: label }] })
            if (v?.label.trim()) await act('workspace.rename', { workspace_id: id, label: v.label.trim() })
          }}
        >
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            const ok = await confirmDialog({
              title: `Close “${label}”?`,
              description: 'All tabs and panes in this workspace will be closed, and their processes terminated.',
              confirmLabel: 'Close workspace',
              destructive: true,
            })
            if (ok) await act('workspace.close', { workspace_id: id })
          }}
        >
          Close workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
