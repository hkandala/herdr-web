// Thin client for herdr's local socket API.
//
// Wire format: newline-delimited JSON. Each request is
//   {"id": "...", "method": "...", "params": {...}}\n
// and herdr answers with one line, {"id", "result"} or {"id", "error": {code, message}},
// then closes the connection. `events.subscribe` is the exception: the connection
// stays open and streams `{event, data}` lines after `subscription_started`.

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SessionEntry } from '../shared/protocol.ts'

export class HerdrError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function configDir(): string {
  if (process.env.HERDR_CONFIG_DIR) return process.env.HERDR_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'herdr')
}

/** The default session listens on <config>/herdr.sock; named ones on <config>/sessions/<name>/herdr.sock. */
export function socketPath(session: string): string {
  if (session === 'default') {
    return process.env.HERDR_SOCKET_PATH || path.join(configDir(), 'herdr.sock')
  }
  return path.join(configDir(), 'sessions', session, 'herdr.sock')
}

export function herdrBinary(): string {
  if (process.env.HERDR_BIN) return process.env.HERDR_BIN
  const local = path.join(os.homedir(), '.local', 'bin', 'herdr')
  return existsSync(local) ? local : 'herdr'
}

let nextId = 0

/** Splits a byte stream into complete lines, keeping the partial tail between chunks. */
function lineReader(onLine: (line: string) => void) {
  let buf = ''
  return (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
    }
  }
}

export function rpc<T = any>(
  sock: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `web-${Date.now().toString(36)}-${nextId++}`
    const conn = net.createConnection(sock)
    let settled = false
    const finish = (err: Error | null, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.destroy()
      if (err) reject(err)
      else resolve(value as T)
    }
    const timer = setTimeout(() => finish(new HerdrError('timeout', `${method} timed out`)), timeoutMs)
    conn.on('connect', () => conn.write(JSON.stringify({ id, method, params }) + '\n'))
    conn.on('data', lineReader((line) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return finish(new HerdrError('bad_response', 'invalid JSON from herdr'))
      }
      if (msg.id !== id) return
      if (msg.error) finish(new HerdrError(msg.error.code, msg.error.message))
      else finish(null, msg.result)
    }))
    conn.on('error', (e) => finish(new HerdrError('connect_failed', e.message)))
    conn.on('close', () => finish(new HerdrError('connect_failed', 'connection closed')))
  })
}

export interface Subscription {
  close(): void
}

/**
 * Opens a long-lived events.subscribe connection. `onClose` fires once, whether
 * herdr dropped us (e.g. a slow subscriber or a server restart) or the
 * subscription was rejected.
 */
export function subscribe(
  sock: string,
  subscriptions: Record<string, unknown>[],
  onEvent: (event: string, data: any) => void,
  onClose: (err?: Error) => void,
): Subscription {
  const id = `web-sub-${nextId++}`
  const conn = net.createConnection(sock)
  let closed = false
  const close = (err?: Error) => {
    if (closed) return
    closed = true
    conn.destroy()
    onClose(err)
  }
  conn.on('connect', () =>
    conn.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n'),
  )
  conn.on('data', lineReader((line) => {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.error) return close(new HerdrError(msg.error.code, msg.error.message))
    if (msg.event) onEvent(msg.event, msg.data)
  }))
  conn.on('error', (e) => close(e))
  conn.on('close', () => close())
  return { close: () => close() }
}

async function isRunning(sock: string): Promise<boolean> {
  if (!existsSync(sock)) return false
  try {
    await rpc(sock, 'ping', {}, 800)
    return true
  } catch {
    return false
  }
}

export async function listSessions(): Promise<SessionEntry[]> {
  const names = ['default']
  try {
    const entries = await readdir(path.join(configDir(), 'sessions'), { withFileTypes: true })
    for (const e of entries) if (e.isDirectory()) names.push(e.name)
  } catch {
    // no named sessions
  }
  const sessions = await Promise.all(
    names.map(async (name) => ({ name, running: await isRunning(socketPath(name)) })),
  )
  return sessions.sort(
    (a, b) =>
      Number(b.running) - Number(a.running) ||
      Number(b.name === 'default') - Number(a.name === 'default') ||
      a.name.localeCompare(b.name),
  )
}
