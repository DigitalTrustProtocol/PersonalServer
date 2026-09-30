# Personal Server — relay sync and ingest

Status: **draft** · 2026-09-30

The Personal Server runs the extension's relay synchronizer, not a new one.
`AttentionX/src/relay/synchronizer.ts`, `filters.ts`, and `live-supervisor.ts`
already take their storage and frontier through ports
(`RelayQueryClient`, `SyncCursorRepository`, `RelayEventRepository`,
`GraphFrontierReader`). They move into `@dtp/relay-sync`
([TrustGraph library.md](../../TrustGraph/specs/library.md)), and the Personal
Server supplies SQLite-backed ports.

Events reach the heap two ways: **relay sync** (this server pulls) and
**ingest** (a writer pushes `EVENT` over the server's WebSocket). Both go
through the same validation pipeline.

## Strategies

Same three strategies as the extension's Data Synchronization settings:

| Strategy | Extension default? | Personal Server |
| --- | --- | --- |
| Interval frontier (`frontier-interval`) | Yes | Available; wake interval 5 / 15 / 30 / 60 min |
| Continuous frontier (`frontier-continuous`) | No (needs keep-warm alarm) | **Default** — the process does not sleep |
| Subscribe all (`global-continuous`) | No | Available; author-unfiltered live `32009` / `32014` / `10011` from now + overlap |

Every strategy also runs a full frontier refresh once per 24 h (extension
`FULL_REFRESH_INTERVAL_MS`). Relays come from the server's settings
(`dtp-personal relays add`).

## Frontier

The sync frontier is [wot-model.md §8](../../TrustGraph/specs/wot-model.md#8-read-helpers-not-scores):
breadth-first over active positive `32009` records in the `identity` chain,
from all roots (configured plus active session roots), sorted, capped. It
ignores the hop threshold because it decides whose events to fetch, not whom
to trust.

| Bound | Extension default | Personal Server default |
| --- | --- | --- |
| `maxDepth` | 2 | 3 |
| `maxAuthorsPerLevel` | 50 | 500 |
| `maxTotalAuthors` | 150 | 5 000 |
| `maxEvents` (32009) | 2 000 | 200 000 |
| `maxRatingEvents` (32014) | 2 000 | 200 000 |
| `maxDiscoveryEvents` (`#i=user:id`) | 400 | 20 000 |

The memory guardrails ([architecture.md § Guardrails](architecture.md#guardrails))
override these: when the heap is at its edge or node limit, the frontier stops
growing. Truncation reasons are shown by `dtp-personal status`.

## Filters and eligibility

Unchanged from the extension (`src/relay/filters.ts`, scope profile `x.com`):

- Author `32009` pulls omit `#s`, so empty-scope and `s=x.com` both match;
  other scopes are dropped at ingest.
- Author `32014` pulls send `#s=x.com`; ingest still checks eligibility.
- X-subject discovery uses `#k=user:id` + `#i=user:id:<digits>` in batches
  of 20, for X accounts named in hinted statements the server already holds.
- Authors are batched 20 per REQ; pages of 200 with `until` pagination;
  at most 20 pages per REQ.

## Identity claims (kind `10011`)

Strict binding needs the candidate npub's `10011`
([TrustGraph identity-binding.md § Claim states](../../TrustGraph/specs/identity-binding.md#3-claim-states)).

| Whose `10011` | When |
| --- | --- |
| All frontier authors | With the regular author pulls (`kinds: [10011]` added to the author REQ) |
| Npubs named by a hint from any frontier author | When the hint is ingested |

Fetches are author-filtered, 20 authors per REQ, and refreshed on the daily
full refresh. While a candidate's claim is still being fetched, strict
results carry `coverage: partial` with `claims-pending`.

Kind `0` is not synced; profile display stays in the extension.

## Cursors, overlap, retries

Same semantics as the extension:

- Per relay / scope / author cursor. Advance only after EOSE on an
  unsaturated final page.
- Next pull starts at `cursor − overlapSeconds`. Duplicates are removed by
  event id across relays.
- Failures persist retry state with backoff; a failed relay leaves the result
  partial, never wrong.
- When an author leaves the frontier (or is pruned), delete that author's
  cursors so a return triggers a full fetch.

## Ingest (`EVENT`)

Writers push over the same WebSocket
([resolver-api.md § Ingest](../../TrustGraph/specs/resolver-api.md#ingest-event)).
On the Personal Server this is open by default (local network only).

| Writer | What it sends |
| --- | --- |
| Attention | Its own signed `32009` / `32014` / `10011` events at local publish time (before the outbox's regret hold ends), so the user's statement counts in the next query; a NIP-09 kind `5` if the user removes a held event |
| A Sync Server or relay router (optional) | A shared stream of events, for example one Sync Server for a household |
| The CLI (`dtp-personal import`) | Exported events |

Each pushed event goes through the pipeline in
[architecture.md § Lifecycle](architecture.md#lifecycle): verify in the worker
pool → scope eligibility → slot reduction → one transaction → heap apply →
`graphVersion`. The frontier is recomputed from the heap after each batch of
32009 changes, with a short debounce (about 1 s) so a burst does one walk.

The Personal Server never publishes to relays. The relay copy of the user's
own event arrives later through sync as a duplicate.

## Global Server as a helper (later)

The Global Server may speed up sync, never replace it. Everything it returns
is re-checked locally.

| Use | Global Server call | What the Personal Server still does |
| --- | --- | --- |
| Frontier bootstrap | `DTP graph.frontier { roots }` | Adds the returned pubkeys as sync targets, fetches their events from relays, validates, and rebuilds its own frontier |
| Missing events | `REQ` with `ids` | Verifies signature, id, and NIP rules before ingest |

Opt-in only. The Global Server learns the roots, which are public keys
anyway, and nothing about what the user browses.
