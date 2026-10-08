// Promise-based confirm/prompt dialogs, so action handlers can `await` them.

import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface Field {
  name: string
  label: string
  value?: string
  placeholder?: string
}

type Request =
  | {
      kind: 'confirm'
      title: string
      description?: string
      confirmLabel?: string
      destructive?: boolean
      resolve: (ok: boolean) => void
    }
  | {
      kind: 'prompt'
      title: string
      description?: string
      confirmLabel?: string
      fields: Field[]
      resolve: (values: Record<string, string> | null) => void
    }

let current: (Request & { id: number }) | null = null
let nextId = 0
const listeners = new Set<() => void>()
const setCurrent = (r: Request | null) => {
  current = r ? { ...r, id: ++nextId } : null
  for (const fn of listeners) fn()
}

export function confirmDialog(opts: Omit<Extract<Request, { kind: 'confirm' }>, 'kind' | 'resolve'>) {
  return new Promise<boolean>((resolve) => setCurrent({ kind: 'confirm', ...opts, resolve }))
}

export function promptDialog(opts: Omit<Extract<Request, { kind: 'prompt' }>, 'kind' | 'resolve'>) {
  return new Promise<Record<string, string> | null>((resolve) => setCurrent({ kind: 'prompt', ...opts, resolve }))
}

export function DialogHost() {
  const req = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
  if (!req) return null
  // Keyed so each request gets fresh form state.
  return <DialogBody key={req.id} req={req} />
}

function DialogBody({ req }: { req: Request }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    req.kind === 'prompt' ? Object.fromEntries(req.fields.map((f) => [f.name, f.value ?? ''])) : {},
  )

  const finish = (ok: boolean) => {
    setCurrent(null)
    if (req.kind === 'confirm') req.resolve(ok)
    else req.resolve(ok ? values : null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && finish(false)}>
      <DialogContent className="dark sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            finish(true)
          }}
        >
          <DialogHeader>
            <DialogTitle>{req.title}</DialogTitle>
            {req.description && <DialogDescription>{req.description}</DialogDescription>}
          </DialogHeader>
          {req.kind === 'prompt' && (
            <div className="grid gap-3">
              {req.fields.map((f, i) => (
                <label key={f.name} className="grid gap-1.5 text-xs text-muted-foreground">
                  {f.label}
                  <Input
                    autoFocus={i === 0}
                    value={values[f.name]}
                    placeholder={f.placeholder}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={req.kind === 'confirm' && req.destructive ? 'destructive' : 'default'}
              autoFocus={req.kind === 'confirm'}
            >
              {req.confirmLabel ?? (req.kind === 'confirm' ? 'Confirm' : 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
