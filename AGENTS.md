# Agent guide (Personal Server)

`dtp-personal`: a local Web-of-Trust server for one person. It holds the
public kinds `32009`, `32014`, `10011` (+ NIP-09 deletions of them) and
answers the shared resolver protocol over one WebSocket. Read
[README.md](README.md), [PLAN.md](PLAN.md), and [specs/](specs/) first.

## Stack

- Node.js ≥ 24 (developed on 26), TypeScript strict, ESM (`NodeNext`), `tsc` to `dist/`.
- `node:sqlite` (WAL) — decision PS-D2; plain `node:http` + `ws` — decision PS-D3.
- The model is the TrustGraph packages, linked with `file:../TrustGraph/packages/<name>`:
  `@dtp/trust-graph` (locked heap), `@dtp/trust-protocol`, `@dtp/trust-query`,
  `@dtp/telemetry-ui`; tests also use `@dtp/conformance`.
- Vitest (integration tests start real servers on random ports), oxlint.

## Commands

| Command | Does |
| --- | --- |
| `npm install` | Needs `../TrustGraph` checked out, installed, and built (`npm ci && npm run build` there) |
| `npm run check` | lint + typecheck (src and tests) + test + build — green before every commit |
| `npm test` | Unit, integration, and the shared corpus against the bundled packages |
| `node dist/cli.js init --data-dir <dir>` then `start` | Run locally |

## Rules

- **The heap is `@dtp/trust-graph`, which is locked** (`AttentionX/src/graph/trust`
  copied verbatim). Never patch it here, never write a second walk or
  resolver, never add compensation logic for its gaps. Reads go through
  `GraphManager` → `@dtp/trust-query` → `IndexResolver`.
- One API with the Global Server: every message, op, default, error code, and
  result field follows [TrustGraph resolver-api.md](../TrustGraph/specs/resolver-api.md).
  Anything not built answers `DTP-ERR … unsupported` and is listed in PLAN.md
  (today: `graph.field`, gap G12; in-walk budgets G10 and binding G8 are
  blocked on decision D3).
- No Nostr user secret keys, no X identity / post data, no kind 0.
- Writes: validate → scope profile → slot reduction → one SQLite transaction →
  heap apply in the same tick → `graphVersion`. Reads never touch SQLite
  (except `REQ` by ids / authors).
- Logs and telemetry never contain subjects, query parameters, or queried roots.
- Spec deviations are fixed in the spec in the same commit and listed in PLAN.md.

## Specs

[architecture](specs/architecture.md) · [sync](specs/sync.md) ·
[security](specs/security.md) · [extension-integration](specs/extension-integration.md) ·
[operations](specs/operations.md) · TrustGraph [resolver-api](../TrustGraph/specs/resolver-api.md),
[wot-model](../TrustGraph/specs/wot-model.md), [telemetry](../TrustGraph/specs/telemetry.md)
