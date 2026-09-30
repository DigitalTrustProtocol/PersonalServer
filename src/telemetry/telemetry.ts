/**
 * Telemetry (TrustGraph telemetry.md): counters, latency samples, in-memory
 * history ring buffers, the shared JSON snapshot, and Prometheus text with the
 * shared `dtp_*` names. Counts and histograms only — never subjects, query
 * parameters, results, queried roots, or IP addresses.
 */

import {
  SHARED_METRICS,
  TELEMETRY_SCHEMA,
  type AlertRow,
  type IngestResultCounts,
  type LatencySummary,
  type LogLine,
  type OperationResultCounts,
  type TelemetrySnapshot,
  type WriterRow,
} from '@dtp/telemetry-ui'

export type IngestResult = keyof IngestResultCounts
export type OpResult = keyof OperationResultCounts
export type ConnectionRole = 'anonymous_reader' | 'member_reader' | 'writer' | 'admin'
export type OriginClass = 'extension' | 'native' | 'other'

const INGEST_KINDS = ['32009', '32014', '10011', '5'] as const
type IngestKind = (typeof INGEST_KINDS)[number]
const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
const SAMPLE_CAP = 2_048
const HISTORY_STEP_SECONDS = 10
const HISTORY_POINTS = (24 * 3600) / HISTORY_STEP_SECONDS
export const HISTORY_SERIES = ['ops', 'ingest', 'rss', 'edges'] as const
export type HistorySeries = (typeof HISTORY_SERIES)[number]

function emptyIngest(): IngestResultCounts {
  return { accepted: 0, duplicate: 0, invalid: 0, blocked: 0, rate_limited: 0, deleted: 0 }
}

function emptyOps(): OperationResultCounts {
  return { ok: 0, busy: 0, rate_limited: 0, invalid: 0, error: 0 }
}

/** Timestamps (ms) in a sliding window, for per-second rates. */
class RateWindow {
  #stamps: number[] = []
  constructor(private readonly windowMs = 60_000) {}
  hit(now = Date.now()): void {
    this.#stamps.push(now)
    if (this.#stamps.length > 100_000) this.#stamps.splice(0, this.#stamps.length - 100_000)
  }
  rate(now = Date.now()): number {
    const from = now - this.windowMs
    while (this.#stamps.length > 0 && this.#stamps[0]! < from) this.#stamps.shift()
    return this.#stamps.length / (this.windowMs / 1000)
  }
}

class Latency {
  samples: number[] = []
  buckets = new Array<number>(DURATION_BUCKETS.length).fill(0)
  sum = 0
  count = 0
  add(seconds: number): void {
    this.samples.push(seconds)
    if (this.samples.length > SAMPLE_CAP) this.samples.shift()
    this.sum += seconds
    this.count += 1
    DURATION_BUCKETS.forEach((le, i) => {
      if (seconds <= le) this.buckets[i]! += 1
    })
  }
  summary(): LatencySummary {
    if (this.samples.length === 0) return { p50: null, p95: null, p99: null, count: this.count }
    const sorted = [...this.samples].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 1000
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), count: this.count }
  }
}

class Ring {
  readonly points: Array<[number, number]> = []
  push(ts: number, value: number): void {
    this.points.push([ts, value])
    if (this.points.length > HISTORY_POINTS) this.points.shift()
  }
}

export interface ConnectionInfo {
  role: ConnectionRole
  origin: OriginClass
  connectedSince: number
  writerPubkey: string | null
  events: number
  rejects: number
  inFlight: number
  pendingOks: number
}

export interface SnapshotContext {
  server: TelemetrySnapshot['server']
  health: TelemetrySnapshot['health']
  graph: Omit<TelemetrySnapshot['graph'], 'bytes' | 'bytesPerEdge' | 'impl'>
  memory: TelemetrySnapshot['memory']
  roots: TelemetrySnapshot['roots']
  config: TelemetrySnapshot['config']
  queueCap: number
  operationDeadlineMs: number
}

export class Telemetry {
  readonly ingest: Record<IngestKind, IngestResultCounts> = {
    '32009': emptyIngest(),
    '32014': emptyIngest(),
    '10011': emptyIngest(),
    '5': emptyIngest(),
  }
  readonly rejectsByPrefix: Record<string, number> = {}
  deletions = 0
  readonly #ingestRate: Record<IngestKind, RateWindow> = {
    '32009': new RateWindow(),
    '32014': new RateWindow(),
    '10011': new RateWindow(),
    '5': new RateWindow(),
  }
  readonly ops = new Map<string, OperationResultCounts>()
  readonly #opRate = new Map<string, RateWindow>()
  readonly #latency = new Map<string, Latency>()
  readonly guardrailHits: Record<string, number> = {}
  readonly connections = new Set<ConnectionInfo>()
  authentications = 0
  slowClientDisconnects = 0
  readonly #logs: LogLine[] = []
  readonly #history = new Map<HistorySeries, Ring>(HISTORY_SERIES.map((s) => [s, new Ring()]))
  #opsSinceSample = 0
  #ingestSinceSample = 0
  readonly #alertSince = new Map<AlertRow['name'], number>()

  recordIngest(kind: number, result: IngestResult, prefix?: string): void {
    const key = (INGEST_KINDS as readonly string[]).includes(String(kind)) ? (String(kind) as IngestKind) : undefined
    if (key) this.ingest[key][result] += 1
    if (result === 'accepted' && key) {
      this.#ingestRate[key].hit()
      this.#ingestSinceSample += 1
    }
    if (result === 'deleted') this.deletions += 1
    if (prefix) this.rejectsByPrefix[prefix] = (this.rejectsByPrefix[prefix] ?? 0) + 1
  }

  recordOperation(op: string, result: OpResult, seconds?: number): void {
    const counts = this.ops.get(op) ?? emptyOps()
    counts[result] += 1
    this.ops.set(op, counts)
    let rate = this.#opRate.get(op)
    if (!rate) {
      rate = new RateWindow()
      this.#opRate.set(op, rate)
    }
    rate.hit()
    this.#opsSinceSample += 1
    if (seconds !== undefined) {
      let latency = this.#latency.get(op)
      if (!latency) {
        latency = new Latency()
        this.#latency.set(op, latency)
      }
      latency.add(seconds)
    }
  }

  guardrail(reason: string): void {
    this.guardrailHits[reason] = (this.guardrailHits[reason] ?? 0) + 1
  }

  log(level: 'warn' | 'error', message: string): void {
    this.#logs.push({ ts: Math.floor(Date.now() / 1000), level, message })
    if (this.#logs.length > 1_000) this.#logs.shift()
  }

  inFlight(): number {
    let total = 0
    for (const c of this.connections) total += c.inFlight
    return total
  }

  pendingOks(): number {
    let total = 0
    for (const c of this.connections) total += c.pendingOks
    return total
  }

  /** Called every 10 s: one point per history series. */
  sample(values: { rssBytes: number; edges: number }, ts = Math.floor(Date.now() / 1000)): void {
    this.#history.get('ops')!.push(ts, this.#opsSinceSample / HISTORY_STEP_SECONDS)
    this.#history.get('ingest')!.push(ts, this.#ingestSinceSample / HISTORY_STEP_SECONDS)
    this.#history.get('rss')!.push(ts, values.rssBytes)
    this.#history.get('edges')!.push(ts, values.edges)
    this.#opsSinceSample = 0
    this.#ingestSinceSample = 0
  }

  history(series: HistorySeries, windowSeconds: number, now = Math.floor(Date.now() / 1000)): Array<[number, number]> {
    const from = now - windowSeconds
    return this.#history.get(series)!.points.filter(([ts]) => ts >= from)
  }

  #writers(): WriterRow[] {
    return [...this.connections]
      .filter((c) => c.role === 'writer')
      .map((c) => ({ pubkey: c.writerPubkey, connectedSince: c.connectedSince, events: c.events, rejects: c.rejects }))
  }

  #alerts(ctx: SnapshotContext, now: number): AlertRow[] {
    let truncatedOps = 0
    let allOps = 0
    for (const counts of this.ops.values()) allOps += counts.ok + counts.busy + counts.invalid + counts.error + counts.rate_limited
    for (const hits of Object.values(this.guardrailHits)) truncatedOps += hits
    let slow = false
    for (const latency of this.#latency.values()) {
      const p95 = latency.summary().p95
      if (p95 !== null && p95 > ctx.operationDeadlineMs) slow = true
    }
    const rss = ctx.memory.rssBytes
    const conditions: Record<AlertRow['name'], boolean> = {
      'not-ready': !ctx.health.ready && ctx.health.stateSinceSeconds > 120,
      'memory-pressure': ctx.memory.limitBytes !== null && rss > 0.85 * ctx.memory.limitBytes,
      'ingest-backlog': ctx.queueCap > 0 && this.pendingOks() > 0.5 * ctx.queueCap,
      'guardrail-storm': allOps > 100 && truncatedOps / allOps > 0.05,
      'source-down': false,
      'slow-queries': slow,
    }
    return (Object.keys(conditions) as Array<AlertRow['name']>).map((name) => {
      if (conditions[name]) {
        if (!this.#alertSince.has(name)) this.#alertSince.set(name, now)
      } else {
        this.#alertSince.delete(name)
      }
      return { name, active: conditions[name], since: this.#alertSince.get(name) ?? null }
    })
  }

  snapshot(ctx: SnapshotContext): TelemetrySnapshot {
    const now = Math.floor(Date.now() / 1000)
    const byRole = { anonymous_reader: 0, member_reader: 0, writer: 0, admin: 0 }
    const byOrigin = { extension: 0, native: 0, other: 0 }
    for (const c of this.connections) {
      byRole[c.role] += 1
      byOrigin[c.origin] += 1
    }
    const opsPerSecond: Record<string, number> = {}
    for (const [op, rate] of this.#opRate) opsPerSecond[op] = rate.rate()
    const latency: TelemetrySnapshot['queries']['latency'] = {}
    const coldEmpty: LatencySummary = { p50: null, p95: null, p99: null, count: 0 }
    for (const [op, samples] of this.#latency) latency[op] = { warm: samples.summary(), cold: coldEmpty }
    const edges = ctx.graph.edges['32009'] + ctx.graph.edges['32014']
    const heapUsed = typeof ctx.memory.impl.v8HeapUsedBytes === 'number' ? ctx.memory.impl.v8HeapUsedBytes : null
    return {
      schema: TELEMETRY_SCHEMA,
      generatedAt: now,
      server: ctx.server,
      health: ctx.health,
      graph: {
        ...ctx.graph,
        // The heap is a JS object graph: its size is only known as part of the V8 heap.
        bytes: { total: heapUsed, resident: heapUsed, pinned: null },
        bytesPerEdge: heapUsed !== null && edges > 0 ? Math.round(heapUsed / edges) : null,
        impl: { heap: 'js-object-graph' },
      },
      ingest: {
        eventsPerSecond: {
          '32009': this.#ingestRate['32009'].rate(),
          '32014': this.#ingestRate['32014'].rate(),
          '10011': this.#ingestRate['10011'].rate(),
          '5': this.#ingestRate['5'].rate(),
        },
        byKind: structuredClone(this.ingest),
        rejectsByPrefix: { ...this.rejectsByPrefix },
        deletions: this.deletions,
        queueDepth: 0,
        queueCap: ctx.queueCap,
        pendingOks: this.pendingOks(),
        writers: this.#writers(),
      },
      sources: {
        // Relay sync is increment P2 (not built): the section exists, empty.
        relays: [],
        frontier: null,
        writers: this.#writers(),
        wantsOpen: 0,
      },
      queries: {
        opsPerSecond,
        totals: Object.fromEntries([...this.ops].map(([op, counts]) => [op, { ...counts }])),
        latency,
        inFlight: this.inFlight(),
        guardrailHits: { ...this.guardrailHits },
        backgroundCompletions: 0,
        fieldCache: null,
      },
      connections: {
        open: this.connections.size,
        byRole,
        byOrigin,
        authentications: this.authentications,
        slowClientDisconnects: this.slowClientDisconnects,
      },
      memory: ctx.memory,
      roots: ctx.roots,
      logs: [...this.#logs],
      config: ctx.config,
      alerts: this.#alerts(ctx, now),
    }
  }

  prometheus(ctx: SnapshotContext): string {
    const snap = this.snapshot(ctx)
    const lines: string[] = []
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
    const metric = (name: string, type: 'gauge' | 'counter' | 'histogram', help: string) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    }
    const sample = (name: string, labels: Record<string, string>, value: number) => {
      const entries = Object.entries(labels)
      const body = entries.length ? `{${entries.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : ''
      lines.push(`${name}${body} ${Number.isFinite(value) ? value : 0}`)
    }
    metric('dtp_up', 'gauge', 'Process is up')
    sample('dtp_up', {}, 1)
    metric('dtp_ready', 'gauge', 'Graph loaded and ingest caught up')
    sample('dtp_ready', {}, snap.health.ready ? 1 : 0)
    metric('dtp_graph_version', 'gauge', 'Current graphVersion')
    sample('dtp_graph_version', {}, snap.graph.graphVersion)
    metric('dtp_epoch_lag_seconds', 'gauge', 'Epoch lag (0 on the Personal Server)')
    sample('dtp_epoch_lag_seconds', {}, snap.graph.epochLagSeconds ?? 0)
    metric('dtp_graph_nodes', 'gauge', 'Heap nodes')
    sample('dtp_graph_nodes', {}, snap.graph.nodes)
    metric('dtp_graph_edges', 'gauge', 'Heap edges by kind')
    sample('dtp_graph_edges', { kind: '32009' }, snap.graph.edges['32009'])
    sample('dtp_graph_edges', { kind: '32014' }, snap.graph.edges['32014'])
    metric('dtp_graph_bytes', 'gauge', 'Graph bytes by tier')
    sample('dtp_graph_bytes', { tier: 'total' }, snap.graph.bytes.total ?? 0)
    sample('dtp_graph_bytes', { tier: 'resident' }, snap.graph.bytes.resident ?? 0)
    sample('dtp_graph_bytes', { tier: 'pinned' }, snap.graph.bytes.pinned ?? 0)
    metric('dtp_ingest_events_total', 'counter', 'Ingested events by kind and result')
    for (const kind of INGEST_KINDS) {
      for (const [result, value] of Object.entries(snap.ingest.byKind[kind])) {
        sample('dtp_ingest_events_total', { kind, result }, value)
      }
    }
    metric('dtp_ingest_queue_depth', 'gauge', 'Ingest queue depth')
    sample('dtp_ingest_queue_depth', {}, snap.ingest.queueDepth)
    metric('dtp_ingest_pending_oks', 'gauge', 'Events waiting for OK')
    sample('dtp_ingest_pending_oks', {}, snap.ingest.pendingOks)
    metric('dtp_source_state', 'gauge', 'Source state (1 = connected)')
    for (const writer of snap.ingest.writers) {
      sample('dtp_source_state', { source: writer.pubkey ?? 'anonymous', type: 'writer' }, 1)
    }
    metric('dtp_want_open', 'gauge', 'Open want demands')
    sample('dtp_want_open', {}, snap.sources.wantsOpen ?? 0)
    metric('dtp_operations_total', 'counter', 'Operations by op and result')
    for (const [op, counts] of Object.entries(snap.queries.totals)) {
      for (const [result, value] of Object.entries(counts)) sample('dtp_operations_total', { op, result }, value)
    }
    metric('dtp_operation_duration_seconds', 'histogram', 'Operation latency')
    for (const [op, latency] of this.#latency) {
      const labels = { op, temperature: 'warm' }
      DURATION_BUCKETS.forEach((le, i) => sample('dtp_operation_duration_seconds_bucket', { ...labels, le: String(le) }, latency.buckets[i]!))
      sample('dtp_operation_duration_seconds_bucket', { ...labels, le: '+Inf' }, latency.count)
      sample('dtp_operation_duration_seconds_sum', labels, latency.sum)
      sample('dtp_operation_duration_seconds_count', labels, latency.count)
    }
    metric('dtp_operations_inflight', 'gauge', 'Operations in flight')
    sample('dtp_operations_inflight', {}, snap.queries.inFlight)
    metric('dtp_guardrail_hits_total', 'counter', 'Guardrail hits by reason')
    for (const [reason, value] of Object.entries(snap.queries.guardrailHits)) {
      sample('dtp_guardrail_hits_total', { reason }, value)
    }
    metric('dtp_background_completions_total', 'counter', 'Background completions')
    sample('dtp_background_completions_total', {}, snap.queries.backgroundCompletions)
    metric('dtp_field_cache_hits_total', 'counter', 'Root-field cache hits (no field cache here)')
    sample('dtp_field_cache_hits_total', {}, 0)
    metric('dtp_field_cache_misses_total', 'counter', 'Root-field cache misses (no field cache here)')
    sample('dtp_field_cache_misses_total', {}, 0)
    metric('dtp_field_cache_bytes', 'gauge', 'Root-field cache bytes (no field cache here)')
    sample('dtp_field_cache_bytes', {}, 0)
    metric('dtp_connections', 'gauge', 'Open connections by role and origin class')
    const pairs = new Map<string, number>()
    for (const c of this.connections) {
      const key = `${c.role}|${c.origin}`
      pairs.set(key, (pairs.get(key) ?? 0) + 1)
    }
    for (const [key, value] of pairs) {
      const [role, origin] = key.split('|') as [string, string]
      sample('dtp_connections', { role, origin }, value)
    }
    metric('dtp_memory_bytes', 'gauge', 'Memory by budget share')
    for (const [share, value] of Object.entries(snap.memory.shares)) sample('dtp_memory_bytes', { share }, value.bytes)
    metric('dtp_memory_limit_bytes', 'gauge', 'Process memory limit')
    sample('dtp_memory_limit_bytes', {}, snap.memory.limitBytes ?? 0)
    metric('dtp_rss_bytes', 'gauge', 'Resident set size')
    sample('dtp_rss_bytes', {}, snap.memory.rssBytes)
    metric('dtp_roots', 'gauge', 'Roots by state')
    sample('dtp_roots', { state: 'active' }, snap.roots.active)
    sample('dtp_roots', { state: 'warming' }, snap.roots.warming)
    metric('dtp_alert', 'gauge', 'Active alerts')
    for (const alert of snap.alerts) sample('dtp_alert', { name: alert.name }, alert.active ? 1 : 0)
    metric('dtp_impl_v8_heap_bytes', 'gauge', 'V8 heap used (implementation detail)')
    sample('dtp_impl_v8_heap_bytes', {}, typeof snap.memory.impl.v8HeapUsedBytes === 'number' ? snap.memory.impl.v8HeapUsedBytes : 0)
    metric('dtp_impl_event_loop_lag_ms', 'gauge', 'Event-loop lag p99 in ms (implementation detail)')
    sample('dtp_impl_event_loop_lag_ms', {}, typeof snap.memory.impl.eventLoopLagP99Ms === 'number' ? snap.memory.impl.eventLoopLagP99Ms : 0)
    return `${lines.join('\n')}\n`
  }
}

export const sharedMetricNames = Object.keys(SHARED_METRICS)
