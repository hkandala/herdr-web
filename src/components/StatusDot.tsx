import type { AgentStatus } from '@shared/protocol'
import { cn } from '@/lib/utils'

const STYLES: Record<AgentStatus, string> = {
  working: 'bg-amber-400 animate-pulse',
  blocked: 'bg-red-500',
  done: 'bg-emerald-400',
  idle: 'bg-neutral-500',
  unknown: 'bg-neutral-700',
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  blocked: 'Needs input',
  done: 'Done',
  idle: 'Idle',
  unknown: 'No agent',
}

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      title={STATUS_LABEL[status]}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', STYLES[status], className)}
    />
  )
}
