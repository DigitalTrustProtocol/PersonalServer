# Personal Server

A local Web-of-Trust server for one person. It holds the WoT Graph heap for
trust (`32009`), ratings (`32014`), and identity claims (`10011`), syncs them
from Nostr relays, accepts the user's own signed events from the Attention
extension, and answers the resolver protocol over a WebSocket on the local
machine or network — for Attention and any other local app.

Status: **design** (specs only, no code yet) · 2026-09-30

## Why

Attention runs its heap inside a Chrome service worker that can stop at any
moment. Each restart pays a rehydrate, continuous sync needs a keep-warm
alarm, and sync bounds stay small to protect the worker. The Personal Server
keeps one warm heap in a normal process, syncs continuously, and serves every
local app and browser profile from it.

## Exactly the same API as the Global Server

Both servers implement one [resolver protocol](../TrustGraph/specs/resolver-api.md):
the same messages, operations, defaults, results, errors, auth, ingest, and
guardrails, proven by one shared session suite. For the extension, switching
between the two is a change of URL.

What differs is only configuration defaults and deployment:

| | Personal deployment | Global deployment |
| --- | --- | --- |
| `listen` | This machine or LAN, never public | Public, TLS |
| `auth.reads` / `auth.writes` | `open` / `open` — the extension can send the user's own signed events | `open` / `members` — only whitelisted writers (Sync Servers) push |
| How events arrive (invisible to clients) | Its own relay sync plus local writers | Sync Servers pushing `EVENT` |
| Data | `32009`, `32014`, `10011` only; no X data | same |

## What it is not

- Not a key holder: no Nostr secret key ever reaches it.
- Not a publisher: the extension's outbox delivers the user's events to
  relays.
- Not an X data store: `xIdentities` and `xPosts` stay in the extension.
- Not multi-tenant: serving other people is the Global Server's job.
- Not a second model: it runs `@dtp/trust-graph`, the same code as the
  extension ([TrustGraph](../TrustGraph/README.md)).

## Specs

| Spec | Contents |
| --- | --- |
| [specs/architecture.md](specs/architecture.md) | Components, process model, guardrails (time, walk, memory), SQLite schema, lifecycle, roots and coverage |
| [specs/sync.md](specs/sync.md) | Relay sync strategies, frontier bounds, filters, `10011` claims, ingest of the extension's events |
| [specs/security.md](specs/security.md) | Local-network default without auth, Origin and Host guards, optional NIP-42 + NIP-43 whitelist |
| [specs/extension-integration.md](specs/extension-integration.md) | Attention's remote backend for both servers: lifecycle, mapping, own events, failure modes |
| [specs/operations.md](specs/operations.md) | CLI, configuration, data directory, packaging, telemetry pages |

The protocol is [TrustGraph resolver-api.md](../TrustGraph/specs/resolver-api.md).
The model is [TrustGraph wot-model.md](../TrustGraph/specs/wot-model.md).

## Increments

Each increment is shipped and tested before the next one is planned.

| ID | Increment | Primary foundation |
| --- | --- | --- |
| P0 | Extract `@dtp/trust-graph`, `@dtp/trust-protocol`, `@dtp/trust-query`; walk budgets (gap G10) and level structure for `graph.field` (gap G12); seed the corpus (needs permission for the locked folder) | Data |
| P1 | Server core: SQLite repository, heap load, WebSocket endpoint (resolver operations, `EVENT` ingest with NIP-09, `REQ` by ids), guardrails, telemetry pages on `127.0.0.1:3871`, CLI `init` / `start` / `status` / `dashboard` / `import` / `export` | Business |
| P2 | Relay sync via `@dtp/relay-sync`: continuous and interval frontier, `10011` claims, relays and roots | Business |
| P3 | **Full shared API**: lookups, neighborhood, `graph.field`, NIP-42 + NIP-43 access settings, NIP-86 management; the session suite passes | Business |
| P4 | Attention remote backend: timeline, Notes, lists, Graph View, own `EVENT`s and kind `5` removal (AttentionX repo) | UI + thin business |

## Open decisions

| ID | Decision |
| --- | --- |
| PS-D1 | Default port (3870 proposed) — **working choice 3870** (admin 3871) |
| PS-D2 | `node:sqlite` vs `better-sqlite3` — **taken: `node:sqlite`** (no native addon on Windows) |
| PS-D3 | HTTP handler for NIP-11 / NIP-86 / health: Fastify vs plain `node:http` (WebSocket via `ws` either way) — **taken: plain `node:http`** |
| PS-D6 | Default `allowedOrigins` — **working choice `chrome-extension://*`** until the Attention extension id is fixed |

Implementation status and remaining work: [PLAN.md](PLAN.md).
