# Personal Server — access and security

Status: **draft** · 2026-09-30

## What the server holds

- Public signed events of kinds `32009`, `32014`, `10011`.
- Roots (public keys), relay settings, and — when auth is enabled — the
  membership list.
- Its own server keypair (signs the NIP-43 membership list).

No Nostr user secret key, no X identity or post data, no browsing history.
The sensitive part of a query is which subjects a client asks about; the
server does not log them.

## Default: local network, no authentication

The settings are the shared ones of
[resolver-api.md § Configuration](../../TrustGraph/specs/resolver-api.md#configuration);
only the Personal defaults differ from a Global deployment.

| Setting | Personal default | Options |
| --- | --- | --- |
| `listen` | `127.0.0.1` / `::1` (this machine) | `lan`: private interfaces only (RFC 1918, link-local, IPv6 ULA); connections from non-private addresses are refused. Never a public interface |
| `auth.reads` | **`open`** | `members` |
| `auth.writes` | **`open`** | `members` (recommended on a shared LAN) |
| `auth.admins` | none — management through the CLI only | pubkeys allowed to use NIP-86 |
| `membership.source` | `nip43` | later `wot` (derived from the owner's web of trust) |

Authentication is off by default because the server is only reachable from
the local machine or network, it holds only public events, and every event it
accepts must carry a valid signature. Set `auth.writes = members` when the
server listens on a shared LAN.

## Guards that apply even without authentication

| Threat | Guard |
| --- | --- |
| A website in the user's browser opens a WebSocket to `127.0.0.1:<port>` (WebSockets are not covered by CORS) | Web `Origin`s must be allowlisted at upgrade: by default any `chrome-extension://` origin (PS-D6; pin `chrome-extension://<Attention id>` with `init --allow-origin`) and configured app origins. Clients that send no `Origin` (native apps, CLI) are allowed. |
| DNS rebinding (`evil.example` resolving to 127.0.0.1) | Reject upgrades and HTTP requests whose `Host` is not the configured local name or address |
| A client sends forged or malformed events | Full validation of every event, whoever sends it |
| A local client removes someone else's event | NIP-09 deletions apply only when signed by the event's own author (the shared rule) |
| Expensive or oversized requests | The guardrails in [resolver-api.md § Guardrails](../../TrustGraph/specs/resolver-api.md#guardrails) and [architecture.md § Guardrails](architecture.md#guardrails) |
| Another OS user reads the data directory | Owner-only permissions (POSIX `0700` / `0600`; Windows ACL for the current user) |
| Logs leaking what the user looks at | Info-level logs never contain subjects or message bodies; body logging needs an explicit debug flag and prints a warning |
| Telemetry pages seen by others | The admin listener binds to loopback only; binding it elsewhere requires `admin.auth = nip98`. Pages show counts, never subjects or queried roots ([TrustGraph telemetry.md § Privacy](../../TrustGraph/specs/telemetry.md#privacy)) |

Chrome's Private Network Access rules restrict public websites from reaching
local addresses; the extension's service worker is expected to be allowed.
Verify on the target Chrome version
([extension-integration.md § Permissions](extension-integration.md#permissions)).

## When authentication is enabled

Standard Nostr relay authentication, the same as the Global Server
([resolver-api.md § Authentication and access](../../TrustGraph/specs/resolver-api.md#authentication-and-access)):

- The server sends `["AUTH", <challenge>]` on connect; clients answer with a
  kind `22242` event (NIP-42).
- Members are listed in a NIP-43 kind `13534` event signed by the server's
  `self` key, with roles `read`, `write`, `admin` (kind `33534`).
- `auth.writes = members` (recommended for a LAN): `EVENT` needs a member
  with `write`; reads stay open. `auth.reads = members` as well: every
  operation needs a member.
- Attention signs the `22242` event in its service worker when the server
  asks; the user's key never leaves the extension.
- Membership is managed with the CLI (`dtp-personal members …`) or with
  NIP-86 over HTTP (NIP-98 auth by an `admin` member).

The later `wot` source derives members from the owner root's web of trust and
publishes them in the same `13534` format.

## Data at rest

SQLite unencrypted inside the owner-only data directory. Everything in it is
public Nostr data, so encryption at rest is not planned.
