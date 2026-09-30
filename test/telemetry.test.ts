import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkMetrics, loadTelemetrySchema, validateSchema } from '@dtp/conformance'
import { SHARED_METRICS } from '@dtp/telemetry-ui'
import { TestClient, actor, startServer, trustEvent, type Harness } from './helpers.js'

let h: Harness

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string; csp?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString()
        if (path === '/admin/api/stream' && body.includes('\n\n')) {
          res.destroy()
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body })
        }
      })
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers['content-type']),
          body,
          ...(res.headers['content-security-policy'] ? { csp: String(res.headers['content-security-policy']) } : {}),
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  h = await startServer()
  const c = await TestClient.connect(h.server.url)
  const a = actor()
  await c.publish(await trustEvent(a, { subject: { type: 'p', value: actor().pk } }))
  await c.dtp('trust.query', { rootPubkey: a.pk, subject: { type: 'i', value: 'post:id:1' } })
  await expect(c.dtp('graph.field', {})).rejects.toBeDefined()
  c.close()
})

afterAll(async () => {
  await h.close()
})

describe('admin listener', () => {
  it('serves /admin/api/telemetry matching schemas/telemetry.v1.json', async () => {
    const res = await get(h.server.adminPort, '/admin/api/telemetry')
    expect(res.status).toBe(200)
    const snapshot = JSON.parse(res.body)
    expect(validateSchema(snapshot, loadTelemetrySchema())).toEqual([])
    expect(snapshot.server.kind).toBe('personal')
    expect(snapshot.graph.edges['32009']).toBe(1)
    expect(snapshot.ingest.byKind['32009'].accepted).toBe(1)
    expect(snapshot.queries.totals['trust.query'].ok).toBe(1)
    expect(snapshot.queries.totals['graph.field'].error).toBe(1)
    expect(snapshot.sources.frontier).toBeNull()
    expect(snapshot.queries.fieldCache).toBeNull()
  })

  it('never exposes subjects or queried roots', async () => {
    const res = await get(h.server.adminPort, '/admin/api/telemetry')
    expect(res.body).not.toContain('post:id:1')
  })

  it('serves /metrics with the shared dtp_* names and labels', async () => {
    const res = await get(h.server.adminPort, '/metrics')
    expect(res.status).toBe(200)
    expect(res.type).toMatch(/text\/plain/)
    expect(checkMetrics(res.body, SHARED_METRICS)).toEqual([])
    expect(res.body).toMatch(/dtp_graph_edges\{kind="32009"\} 1/)
  })

  it('streams snapshots over SSE and serves history', async () => {
    const stream = await get(h.server.adminPort, '/admin/api/stream')
    expect(stream.type).toMatch(/text\/event-stream/)
    expect(stream.body).toMatch(/^event: snapshot\ndata: \{/)
    h.server.telemetry.sample({ rssBytes: 1, edges: 1 })
    const history = JSON.parse((await get(h.server.adminPort, '/admin/api/history?series=edges&window=600')).body)
    expect(history.series).toBe('edges')
    expect(history.points.length).toBeGreaterThan(0)
    expect((await get(h.server.adminPort, '/admin/api/history?series=nope')).status).toBe(400)
  })

  it('serves the telemetry UI with a strict CSP and checks Host / Origin', async () => {
    const page = await get(h.server.adminPort, '/')
    expect(page.status).toBe(200)
    expect(page.body).toContain('<script type="module"')
    expect(page.csp).toMatch(/default-src 'self'/)
    expect((await get(h.server.adminPort, '/../package.json')).status).toBe(404)
    expect((await get(h.server.adminPort, '/metrics', { Host: 'evil.example' })).status).toBe(421)
    expect((await get(h.server.adminPort, '/metrics', { Origin: 'https://evil.example' })).status).toBe(403)
  })
})
