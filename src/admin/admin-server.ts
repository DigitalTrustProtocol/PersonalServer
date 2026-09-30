/**
 * Admin listener (telemetry.md § Admin listener): loopback only, read-only
 * pages from @dtp/telemetry-ui, `/admin/api/telemetry`, `/admin/api/stream`
 * (SSE, a full snapshot every 2 s), `/admin/api/history`, and `/metrics`.
 * `Host` and `Origin` are checked like on the protocol socket.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { HISTORY_SERIES, type HistorySeries } from '../telemetry/telemetry.js'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export const STREAM_INTERVAL_MS = 2_000

export interface AdminDeps {
  assetsDir: string | undefined
  snapshot(): unknown
  metrics(): string
  history(series: HistorySeries, windowSeconds: number): Array<[number, number]>
  allowedHosts(): ReadonlySet<string>
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
  })
  res.end(body)
}

export class AdminServer {
  readonly server: Server
  readonly #deps: AdminDeps
  readonly #streams = new Set<ServerResponse>()
  #timer: NodeJS.Timeout | undefined

  constructor(deps: AdminDeps) {
    this.#deps = deps
    this.server = createServer((req, res) => this.#handle(req, res))
  }

  async listen(port: number, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.#timer = setInterval(() => this.#broadcast(), STREAM_INTERVAL_MS)
    this.#timer.unref()
    const address = this.server.address()
    return typeof address === 'object' && address ? address.port : port
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    for (const res of this.#streams) res.end()
    this.#streams.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  #broadcast(): void {
    if (this.#streams.size === 0) return
    const data = `event: snapshot\ndata: ${JSON.stringify(this.#deps.snapshot())}\n\n`
    for (const res of this.#streams) res.write(data)
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const host = (req.headers.host ?? '').toLowerCase()
    if (!this.#deps.allowedHosts().has(host)) return send(res, 421, 'unknown host')
    const origin = req.headers.origin
    if (origin && origin !== `http://${host}`) return send(res, 403, 'origin not allowed')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'read-only')
    const url = new URL(req.url ?? '/', `http://${host}`)
    switch (url.pathname) {
      case '/admin/api/telemetry':
        return send(res, 200, JSON.stringify(this.#deps.snapshot()), 'application/json; charset=utf-8')
      case '/metrics':
        return send(res, 200, this.#deps.metrics(), 'text/plain; version=0.0.4; charset=utf-8')
      case '/admin/api/history': {
        const series = url.searchParams.get('series') as HistorySeries | null
        if (!series || !(HISTORY_SERIES as readonly string[]).includes(series)) {
          return send(res, 400, JSON.stringify({ error: `series must be one of ${HISTORY_SERIES.join(', ')}` }), 'application/json')
        }
        const windowSeconds = Math.min(Math.max(Number(url.searchParams.get('window') ?? 3600) || 3600, 10), 86_400)
        return send(res, 200, JSON.stringify({ series, points: this.#deps.history(series, windowSeconds) }), 'application/json; charset=utf-8')
      }
      case '/admin/api/stream': {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        })
        res.write(`event: snapshot\ndata: ${JSON.stringify(this.#deps.snapshot())}\n\n`)
        this.#streams.add(res)
        req.on('close', () => this.#streams.delete(res))
        return
      }
      default:
        return this.#static(url.pathname, res)
    }
  }

  #static(pathname: string, res: ServerResponse): void {
    const dir = this.#deps.assetsDir
    if (!dir) return send(res, 404, 'telemetry UI assets are not built')
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
    const file = normalize(join(dir, relative))
    if (!file.startsWith(normalize(dir) + sep) && file !== normalize(join(dir, 'index.html'))) {
      return send(res, 404, 'not found')
    }
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found')
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
    })
    createReadStream(file).pipe(res)
  }
}
