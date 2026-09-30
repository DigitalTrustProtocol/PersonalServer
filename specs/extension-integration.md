# Attention extension integration

Status: **draft** · 2026-09-30 · describes changes in the AttentionX repo, to
be planned there as their own increments. Covers both servers.

## One client for both servers

Both servers implement exactly the same [resolver protocol](../../TrustGraph/specs/resolver-api.md).
The extension has **one remote backend with no server-specific code**; a
server is a URL. The only thing the extension adapts to is what the server
advertises: if its NIP-11 document says writes are open (or the user is a
member with role `write`), the extension also sends the user's own signed
events. With the recommended defaults that is true for a Personal Server and
false for a Global Server.

| Concern | In this browser (today) | Remote server |
| --- | --- | --- |
| X observation (content script, page-world) | extension | extension |
| Vault, keys, signing (including NIP-42 auth events) | extension | extension |
| UI, panel session, operator detection (`twid`) | extension | extension |
| `xIdentities`, `xPosts`, and their rules | extension | extension |
| Outbox (regret hold, relay delivery) | extension | extension |
| Graph heap, resolve, lookups | extension service worker | **server** |
| WoT relay sync | extension | the server's business (its own sync or Sync Servers) |
| Own signed events into the heap | local heap at once | `EVENT` to the server at once when writes are allowed; otherwise via relays after the hold |
| Own identity evidence (Bio / linking post) in binding | used | not used |
| Decorating results with X chrome | Graph instance | extension, from its own `xIdentities` / `xPosts` |

`GraphManager` stays the facade `backend.ts` calls in all modes; in a server
mode it forwards heap work to the server. No second pipeline. `contracts.ts`
does not change for content or popup, and content scripts never talk to a
server.

## Settings

Settings → Data synchronization → **Graph backend**:

| Option | Behaviour |
| --- | --- |
| In this browser (default) | Today's behaviour |
| Personal Server | URL (default `ws://127.0.0.1:3870/`), status line |
| Global Server | URL, privacy notice: "This server learns your public key and the X accounts and posts you look at. It never receives your X identity data." |

Settings → Web of trust → **X account binding**: Lenient (proposed default) or
Strict, sent as `bindingMode` in the session defaults
([TrustGraph identity-binding.md](../../TrustGraph/specs/identity-binding.md)).

Demo mode always uses the local heap; demo data is never sent to a server.
Settings live in `chrome.storage.local`. No new IndexedDB store is needed.

## Connection lifecycle (both servers)

1. Open the WebSocket on the first request that needs it.
2. If the server sends `["AUTH", <challenge>]` and later answers
   `auth-required:`, sign a kind `22242` event with the active key in the
   service worker and send `["AUTH", <event>]` (NIP-42). With `open` access
   (the Personal default) nothing is signed.
3. `DTP session.update` with the defaults: root (active operator's pubkey),
   green and red knobs, max degree, binding mode, statement limit. Send it
   again when a setting or the operator changes.
4. Pipeline `DTP` requests; send identical in-flight batch items once; time
   out after 1.5 s.
5. `DTP subscribe ["graph"]` while the socket is open. Turn `graph` pushes
   into the existing `trustGraph` broadcast, **debounced to at most one every
   2 s**, so the timeline does not re-query in a storm; with
   `changed.subjects`, invalidate only those.
6. Close after 60 s without requests. No keep-alive alarm; the worker may
   sleep and reconnects on the next call. A new `instanceId` discards numeric
   node ids from earlier results.

## Mapping

| Extension today | Remote server (either) |
| --- | --- |
| `QUERY_TRUST(_BATCH)`, `QUERY_RATING(_BATCH)` | `DTP trust.query` / `trust.batch`, `rating.query` / `rating.batch` |
| `QUERY_INCOMING_TRUST` (who trusts this person) | `DTP lookup.incoming` with `mergeKeys: true` and the key set the extension builds today from its own `xIdentities` row (`user:id:X` plus the row's npubs — `#incomingUserLookupKeys`) |
| `QUERY_OUTGOING_TRUST` (whom this person trusts) | `DTP lookup.outgoing` with the person's pubkeys as keys |
| Notes: who rated this post, what this user rated | `DTP lookup.incoming` / `lookup.outgoing` with `kinds: [32014]` |
| Application pages (Users, Posts, Events drill-down) | `DTP lookup.*` with `order`, `limit`, `cursor`; `lookup.counts` for headers and badges |
| `GET_GRAPH_NEIGHBORHOOD`, Graph View expand | `DTP graph.neighborhood`; several nodes at once with `lookup.batch`; decorated locally with `xIdentities` / `xPosts` |
| Relay sync, live subscriptions, `attentionx-live-sync` alarm, `StoragePruner` for WoT events | Off — the server owns WoT sync and retention |
| Identity pipeline, post chrome, outbox, publishing to relays | Unchanged, local |

When the server accepts the user's writes (NIP-11 `restricted_writes` is
false, or the user is a member with role `write`):

| Extension today | Remote server |
| --- | --- |
| Local publish write-through (`GraphManager.applyRecord` after signing) | `["EVENT", <full signed event from IndexedDB>]` at once (heap records have `sig` stripped, so never send those) |
| Outbox removal during the regret hold | `["EVENT", <NIP-09 kind 5 for that event id>]` to the same server, never to relays |

When it does not (the Global default), the user's new statements count once
the outbox has published them and a writer (Sync Server) has pushed them in;
the Notes panel shows the pending statement from the local outbox until then.
The code path is the same either way; only the advertised access differs.

**Own identity evidence.** Neither server receives X data, so a Bio or
linking-post npub the extension saw counts on a server only after the user's
own trust statement carries it as the npub hint (the publishing rule,
identity-binding §9). The Bindings UI shows such accounts as "not yet linked
on the server".

## Hot path

`content → QUERY_TRUST_BATCH → service worker → DTP trust.batch → heap`.

| Target | Personal Server (local) | Global Server |
| --- | --- | --- |
| 50-item batch, p95 | < 5 ms | < 60 ms including network |
| 200-item batch, p95 | < 15 ms | < 120 ms including network |

The content scan batching (about 180 ms) stays as is. Any result memo lives in
`GraphManager` and is keyed by `graphVersion`.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Server unreachable or request timeout | Fail open: no chips, same as "no evidence"; popup shows "Server unreachable" with the URL and **Retry**; no retry loop on the hot path |
| `auth-required` or `restricted` | Status "Not allowed by this server" with the reason |
| `busy` | Back off for that connection; drop the oldest queued batch rather than queue indefinitely |
| `truncated` (guardrail) | Show as partial evidence, same indicator as `rebuilding` |
| `coverage: partial` | Same indicator as `rebuilding` ("Rebuilding web of trust") |
| User switches back to "In this browser" | Local heap loads from IndexedDB; it has own events and whatever was synced before, so Settings suggests a sync |

## Permissions

Optional host permissions, requested with a user gesture when the user picks
a server: `http://127.0.0.1/*`, `http://localhost/*`, and the chosen LAN or
public origin. This is a manifest change and must be documented in the
extension's permission docs and privacy policy. Verify whether WebSocket
connections from the service worker need them, and the Private Network Access
behaviour for local addresses, on the target Chrome version.

## Tests (extension side)

- `GraphManager` against a fake server: session defaults, pipelining,
  `graph` push → debounced `trustGraph`, fail-open on timeout, reconnect after
  worker restart, NIP-42 answer only when asked.
- The remote backend has no branch on server type: the same tests run
  against a fake server configured as a Personal deployment and as a Global
  deployment, and differ only where the advertised access differs.
- With writes allowed it sends full signed events (with `sig`) and a kind `5`
  only to that server; with writes restricted and the user not a writer, it
  sends no `EVENT`.
- No X identity or post data is ever sent to a server.
- Demo mode never calls a server.
- The shared conformance runner passes against the bundled
  `@dtp/trust-graph` (unchanged local behaviour).

## Rollout

| Step | Increment | Scope |
| --- | --- | --- |
| 1 | PersonalServer P4 | One remote backend: timeline, Notes, lists, Graph View, Application pages, own `EVENT`s and kind `5` removal — tested first against a Personal Server |
| 2 | GlobalServer G5 | The same backend pointed at a Global Server URL, plus the privacy notice; no new code path |
