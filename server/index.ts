// herdr-web bridge: serves the built UI and relays herdr's socket API to browsers
// over a single WebSocket at /ws.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'
import { Connection } from './connection.ts'
import { configDir, herdrBinary } from './herdr.ts'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
  },
})

const PORT = Number(args.port ?? process.env.HERDR_WEB_PORT ?? 7681)
const HOST = args.host ?? process.env.HERDR_WEB_HOST ?? '127.0.0.1'
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST)
// Anything beyond loopback can reach real shells, so require a token there.
const TOKEN = args.token ?? process.env.HERDR_WEB_TOKEN ?? (LOOPBACK ? '' : randomBytes(18).toString('base64url'))
const COOKIE = 'herdr_web_token'
const DIST = path.resolve(import.meta.dirname, '..', 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
}

function tokenOk(candidate: string | null | undefined): boolean {
  if (!TOKEN) return true
  if (!candidate) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie ?? ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return decodeURIComponent(v.join('='))
  }
}

/**
 * Blocks DNS rebinding on loopback binds: a hostile page whose domain resolves to
 * 127.0.0.1 would otherwise be same-origin with us.
 */
function hostAllowed(req: http.IncomingMessage): boolean {
  if (!LOOPBACK) return true
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return ['localhost', '127.0.0.1', '::1', os.hostname()].includes(host)
}

/** Browsers always send Origin on WebSocket upgrades; it must match the page's host. */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.searchParams.has('token')) {
    // Exchange the URL token for a cookie, then drop it from the address bar.
    const t = url.searchParams.get('token')
    if (!tokenOk(t)) return deny(res, 401)
    url.searchParams.delete('token')
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(t!)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      Location: url.pathname + url.search,
    })
    return res.end()
  }
  if (!tokenOk(cookieToken(req))) return deny(res, 401)
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    return res.end('UI not built. Run `npm run build`, or use `npm run dev` and open the Vite URL.')
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname))
  if (!file.startsWith(DIST + path.sep)) return deny(res, 403)
  const info = await stat(file).catch(() => null)
  if (!info || info.isDirectory()) file = path.join(DIST, 'index.html')
  const body = await readFile(file)
  const ext = path.extname(file)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  res.end(body)
}

function deny(res: http.ServerResponse, code: number) {
  res.writeHead(code, { 'Content-Type': 'text/plain' })
  res.end(code === 401 ? 'Unauthorized: open the URL printed by herdr-web (it includes ?token=…)' : 'Forbidden')
}

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) return deny(res, 403)
  serveStatic(req, res).catch((e) => {
    res.writeHead(500)
    res.end(String(e))
  })
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname !== '/ws' || !hostAllowed(req) || !originAllowed(req) || !tokenOk(cookieToken(req))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => new Connection(ws, url.searchParams.get('session')))
})

server.listen(PORT, HOST, () => {
  const shownHost = HOST.includes(':') ? `[${HOST}]` : HOST
  const url = `http://${shownHost === '0.0.0.0' ? os.hostname() : shownHost}:${PORT}/${TOKEN ? `?token=${TOKEN}` : ''}`
  console.log(`herdr-web listening on ${url}`)
  console.log(`  herdr binary: ${herdrBinary()}`)
  console.log(`  herdr config: ${configDir()}`)
})
