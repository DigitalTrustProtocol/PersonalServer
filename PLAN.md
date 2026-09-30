# Personal Server — implementation plan

Status: living document · started 2026-09-30. Source of truth: [README.md](README.md),
[specs/](specs/), and the shared TrustGraph specs
([resolver-api.md](../TrustGraph/specs/resolver-api.md),
[wot-model.md](../TrustGraph/specs/wot-model.md),
[telemetry.md](../TrustGraph/specs/telemetry.md)). The same API as the
Global Server is the goal; where this server cannot offer an operation yet it
answers `unsupported` and the gap is listed here.

Legend: ✅ done · 🟡 partial (what is missing is listed) · ⏳ not started · ⛔ blocked on a decision.

## Increments (README § Increments)

### P0 — shared packages 🟡 (TrustGraph; see [TrustGraph/PLAN.md](../TrustGraph/PLAN.md))

- [x] `@dtp/trust-graph` copied verbatim from `AttentionX/src/graph/trust`
      (only the five external imports and the `EventRecord` type import changed),
      proven by the extension's own tests running unchanged.
- [x] `@dtp/trust-protocol`, `@dtp/trust-query` (lookups, frontier, NIP-09
      floors, result shaping), `@dtp/conformance` + corpus, `@dtp/telemetry-ui`,
      `@dtp/resolver-client`.
- [ ] ⛔ D3: walk budgets (G10), level structure for `graph.field` (G12),
      binding inside the walk (G8). Not implemented anywhere; no workaround.

### P1 — server core ✅

- [x] Data dir per OS, `config.json` + env overrides (`DTP_PERSONAL_*`),
      settings table; server keypair (`server.key`, owner-only).
- [x] SQLite (`node:sqlite`, WAL) with the architecture.md schema: `events`
      (winners incl. Delete winners and `10011`, graph columns, `hint_pubkey`,
      `claim_twitter_id`), `sync_cursors`, `relay_observations`,
      `slot_floors`, `roots`, `members`, `settings`; numbered migrations.
- [x] Heap load on start from graph columns (no signature checks, no tag
      parsing): claims onto the Graph instance, floors, then winners;
      `graphVersion = 1`, new `instanceId` per start.
- [x] Write path: `classifyEvent` (full NIP-32009 / 32014 / NIP-39 / NIP-09
      validation + scope profile `x.com`) → floor check → slot reduction →
      one transaction (superseded row and its observations deleted) → heap
      apply in the same tick → `graphVersion` → `graph` push.
- [x] NIP-09: `e` (winner by the same author; floor = its `created_at`) and
      `a` (own slots of held kinds; floor = deletion time; a newer winner
      stays); re-pushes answer `blocked: deleted`; kind 5 is not stored.
- [x] One WebSocket endpoint (`ws`, permessage-deflate, 4 MB frames): `EVENT`
      with NIP-01 `OK` prefixes; `REQ` limited reads (`ids` ≤ 500,
      `authors` ≤ 20 + held `kinds`, NIP-43 kinds 13534 / 33534; else
      `CLOSED unsupported:`); `CLOSE`; `AUTH`; `DTP` / `DTP-CANCEL`;
      `NOTICE` for malformed frames.
- [x] DTP operations: `info`, `session.update` (defaults + active roots),
      `trust.query` / `trust.batch`, `rating.query` / `rating.batch`,
      `lookup.incoming` / `outgoing` / `counts` / `batch`,
      `graph.neighborhood`, `graph.frontier`, `identity.claims`,
      `subscribe` / `unsubscribe` (`graph` pushes, ≤ 4/s, changed subjects),
      `graph.field` → `unsupported` (G12).
- [x] Guardrails that do not need the walk: batch / key / lookup-batch caps
      (`invalid`), page and statement / path / neighborhood clamps with
      truncation reasons, `maxLookupRecords`, `maxInFlight` (`busy`),
      `maxConnections` per IP (429 at upgrade), `maxUnsentOutput` (slow
      client terminated), `maxPendingOks` (socket paused), `batchDeadline` /
      `deadlineMs` / operation deadline checked **between** operations
      (remaining items `timeout`), heap edge cap at ingest
      (`rate-limited:`), `maxDepth` clamp. DTP-CANCEL is honoured between
      batch items (batches yield every ~5 ms).
- [x] NIP-11 on `GET /` (`Accept: application/nostr+json`) with `self`,
      `limitation`, and `dtp { api, model, corpus, instanceId, scopeProfile,
      capabilities, unsupported, gaps, limits }`; `/healthz`, `/readyz`.
- [x] Access: `Host` allow-list (DNS rebinding) on HTTP and upgrade, `Origin`
      allow-list at upgrade, `listen = lan` refuses non-private peers,
      keepalive pings 20 s / 60 s, idle read-only close after 5 min.
- [x] Admin listener `127.0.0.1:<port+1>`: telemetry UI (`@dtp/telemetry-ui`,
      strict CSP), `/admin/api/telemetry` (validated against
      `schemas/telemetry.v1.json`), `/admin/api/stream` (SSE, full snapshot
      every 2 s), `/admin/api/history` (24 h ring buffers at 10 s),
      `/metrics` (shared `dtp_*` names, checked against `SHARED_METRICS`).
- [x] CLI `dtp-personal`: `init`, `start`, `status [--json]`, `dashboard`,
      `import` (JSON Lines / array / `{events}`; via the running server or
      offline through the same pipeline), `export`, `roots`, `relays`,
      `sync`, `auth`, `members`, `query trust|rating`.
- [x] Logging: console + rotating files (10 × 10 MB); warn / error feed the
      Logs page; no subjects or bodies at info.
- [x] Signature-verification worker pool (architecture.md § Process model):
      `worker_threads`, `min(4, max(1, cores − 1))` workers by default
      (`verifyWorkers` setting), started on first use; the offline CLI import
      verifies inline.
- [ ] Ingest applied in ≤ 5 ms slices during sync bursts: relay events are
      applied one by one as they arrive (each awaits its signature check),
      which yields between events but has no explicit slice budget.

Acceptance (all automated, `npm test`): integration tests start the server
on random ports with a temp data dir, sign events with nostr-tools, push
them, and check `OK` prefixes, trust / rating queries and batches, lookups
with paging and counts, neighborhood, frontier, claims, NIP-09 floors (also
across a restart), `REQ` by ids / authors / NIP-43, NIP-11, Host / Origin
refusals, telemetry schema and `/metrics` names, `busy`, CLI import /
export. The shared corpus runs against the bundled packages.

### P2 — relay sync 🟡

- [x] `@dtp/relay-sync`: port of `AttentionX/src/relay/{synchronizer,filters,live-supervisor,retry,types,graph}.ts`
      (import rewrites only; the extension's relay tests pass unchanged).
- [x] Ports on this server: `SqliteCursorRepository` (`sync_cursors`),
      `PipelineEventRepository` (the same ingest pipeline as `EVENT`, source
      `relay`), `HeapFrontierReader` (trust-query frontier over the heap),
      provenance into `relay_observations` (pruned with the winner),
      `RelayPool` on Node's global `WebSocket` (query + live subscribe).
- [x] Strategies: `frontier-continuous` (default: pass, then live frontier
      subscriptions; a new pass when the frontier or the relay list changes,
      every 15 min, on `sync refresh`; the synchronizer's own 24 h full
      refresh), `frontier-interval` (pass every N minutes),
      `global-continuous` (live 32009 / 32014 of everyone). PS bounds:
      depth 3, 500 / level, 5 000 total, 200 000 / 200 000 / 20 000 events.
- [x] `10011` for frontier authors and for npubs their statements hint
      (20 authors per REQ, after each pass).
- [x] Roots: configured + active session roots; `coverage: partial`
      `root-warming` until the root's first complete pass, then a
      `coverage` push; heap edge cap pauses frontier growth.
- [x] Telemetry Sources (relay rows, frontier size and truncation),
      `dtp_source_state{type="relay"}`, `source-down` alert; CLI
      `sync start|stop|refresh|strategy`, `relays add|remove|list`.
- [x] Test: an in-process relay; the server syncs the root's frontier,
      fetches claims, answers queries, pushes `coverage`, and follows a live
      event.
- [ ] `claims-pending` coverage (only meaningful once strict binding exists, G8).
- [ ] `global-continuous` does not include `10011` yet (ported
      `GLOBAL_SYNC_KINDS` is 32009 / 32014; specs/sync.md notes it).
- [ ] Prune out-of-WoT authors when the heap is at its cap (today growth
      stops; nothing is evicted).
- [ ] Global Server as a sync helper (`graph.frontier` bootstrap, `REQ ids`) — later, opt-in.

### P3 — full shared API 🟡

- [x] NIP-42 `AUTH` (kind 22242, ±10 min, challenge, relay host) with
      `auth.reads` / `auth.writes = members` (`auth-required:` /
      `restricted:`), several pubkeys per connection.
- [x] NIP-43 membership: kind 13534 list and 33534 role definitions signed
      by `self`, re-signed on change, readable with `REQ`; CLI `members`.
- [x] NIP-86 over HTTP with NIP-98 (`supportedmethods`, `allowpubkey`,
      `unallowpubkey`, `listallowedpubkeys`, `banpubkey`,
      `listbannedpubkeys`, `assignrole`, `unassignrole`) for `auth.admins`
      or `admin` members.
- [x] Lookups, neighborhood (see P1).
- [ ] ⛔ D3 / G12: `graph.field`.
- [ ] ⛔ D3 / G10: in-walk guardrails (`completeDepth`, `timeBudget` /
      `nodeBudget` / `edgeBudget` inside a walk, `maxReachedNodes`,
      `maxWalkRecords`, `maxColdWalks` queueing). Reported in `dtp.limits`
      but not enforceable: a synchronous walk cannot be interrupted.
- [ ] ⛔ D3 / G8: identity binding (lenient / strict) — the server has no
      binds at all; `user:id` results carry `coverage: partial`
      `binding-unsupported`.
- [x] Session suite v1 (`TrustGraph/corpus/sessions/basic-open.json`, 29
      steps) runs against a fresh server on every `npm test`.
- [ ] More sessions (auth flows, pushes, guardrail responses) and the
      side-by-side run with the Global Server.
- [ ] `maxWriterConnections` per pubkey, `rateLimit` settings, `admin.auth =
      nip98` for a non-loopback admin listener.

### P4 — Attention remote backend ⏳ (AttentionX repo; out of scope here)

## Decisions taken

| ID | Decision | Rationale |
| --- | --- | --- |
| PS-D1 | Port 3870, admin 3871 (`init` skips to the next free pair) | Spec proposal |
| PS-D2 | `node:sqlite` | No native addon to build on Windows; synchronous API fits "compare + write in one tick" |
| PS-D3 | Plain `node:http` + `ws` (`noServer`) | Four routes; no framework needed; one port for HTTP and the socket |
| PS-D4 | Heap records carry graph columns and `content` only (no tags / sig) | Minimal memory; `REQ` reads full events from SQLite |
| PS-D5 | Claims live on the Graph instance (WeakMap, like the extension's chrome maps) | `identity.claims` answers from memory; no SQLite on the query path |
| PS-D6 | Default `allowedOrigins = chrome-extension://*` | Unpacked extension ids differ per install; websites stay refused; `init --allow-origin` pins it (specs updated) |
| PS-D7 | Default score context: `identity` for trust, `""` for ratings | Product profile `attention` (wot-model §9); a scrolling client sends only subjects. Added to resolver-api.md |
| PS-D8 | `user:id` results report `coverage: partial` + `binding-unsupported` | Honest signal that G8 is missing on servers (added to resolver-api.md as interim) |
| PS-D9 | `graph` push `changed.subjects` = changed statement's subject + author, and `i:user:id:<n>` for claims | Resolver-api left it open; documented there |
| PS-D10 | Heap edge cap refuses **new** slots with `rate-limited:`; replacements still apply | Without sync there is no frontier to shrink; refusing growth is the only safe action |
| PS-D11 | All latency is reported as `warm` | The heap is always resident; there are no cold walks on this server |
| PS-D12 | A kind 5 that matches nothing answers `OK false blocked:` | Not stored; documented in resolver-api.md |

## Deviations from the specs (all recorded in the specs as well)

| Spec | Deviation |
| --- | --- |
| resolver-api.md § Connection | `capabilities` omits `graph.field`; `dtp.unsupported` and `dtp.gaps` are added (interim until D3) |
| operations.md / security.md | `allowedOrigins` default (PS-D6) |
| telemetry.md | SSE sends full snapshots, not deltas |
| sync.md | `global-continuous` subscribes 32009 / 32014 only (no 10011 yet) |

## Blockers (owner decisions)

| ID | Blocks |
| --- | --- |
| **D3** | G10 (walk budgets: `completeDepth`, time / node / record budgets inside a walk) and G12 (`graph.field`) — required before this server offers the full shared API and before the session suite can pass on both servers. Also G8 (binding inside the walk): until then the server answers `user:id` subjects without binds. |
| D5 | Default binding mode (the server accepts `lenient` / `strict` but cannot act on it before G8) |
| D1 / D2 | Library home and npm scope (`@dtp/*` is a working name; packages are linked with `file:`) |
