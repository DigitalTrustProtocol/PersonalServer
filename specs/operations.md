# Personal Server — CLI, configuration, packaging

Status: **draft** · 2026-09-30

## Runtime

- Node.js 24 LTS or newer. TypeScript, ESM, strict.
- Dependencies kept small: `@dtp/*` packages, a WebSocket server (`ws`), an
  HTTP handler for NIP-11 / NIP-86 / health on the same port (Fastify or plain
  `node:http`, decision PS-D3), `nostr-tools` (via `@dtp/trust-protocol`).
  Outbound relay connections use Node's built-in `WebSocket` client.
- One port: `ws://127.0.0.1:3870/` for the protocol, HTTP on the same URL.
- The launcher sets `--max-old-space-size` from the memory guardrail
  ([architecture.md § Guardrails](architecture.md#guardrails)).

## CLI

Binary name `dtp-personal`.

| Command | Does |
| --- | --- |
| `dtp-personal init [--port 3870] [--listen local\|lan]` | Create the data directory, config, database, and the server keypair |
| `dtp-personal start` | Run in the foreground (console app); `Ctrl+C` stops cleanly |
| `dtp-personal status` | The telemetry snapshot as text: graph size vs guardrails, `graphVersion`, roots, sync state per relay, truncation reasons, open connections, alerts, event-loop lag |
| `dtp-personal dashboard` | Open the telemetry pages (`http://127.0.0.1:3871/`) in the default browser |
| `dtp-personal roots add \| remove \| list <npub\|hex>` | Manage configured roots (active session roots are added automatically) |
| `dtp-personal relays add \| remove \| list <wss://…>` | Manage relays |
| `dtp-personal sync start \| stop \| refresh` | Control sync |
| `dtp-personal auth reads\|writes open\|members` | Set `auth.reads` / `auth.writes` (both default `open`) |
| `dtp-personal members add \| remove \| list <npub> [--role read\|write\|admin]` | Manage the NIP-43 membership list (used when auth is on) |
| `dtp-personal export --out events.jsonl` | Signed winners as JSON Lines (verifiable by anyone) |
| `dtp-personal import <file>` | Validate and ingest JSON Lines, or the extension's event export file (format to confirm) |
| `dtp-personal query trust <root> <subject>` | Debug query printed as JSON |

`status` and `query` connect to the running server over the local socket like
any other client.

## Configuration

`config.json` in the data directory; environment variables override
(`DTP_PERSONAL_PORT`, `DTP_PERSONAL_LISTEN`, `DTP_PERSONAL_DATA_DIR`,
`DTP_PERSONAL_LOG_LEVEL`). The file holds bootstrap values (port, listen
scope, data directory, log level, allowed web origins); everything else is in
the `settings` table and changed with the CLI or NIP-86.

| Setting | Default |
| --- | --- |
| Port | **3870** (decision PS-D1); `init` picks the next free port if taken |
| `listen` | `local` (loopback); `lan` for private interfaces only |
| `auth.reads`, `auth.writes` | `open`, `open` |
| `allowedOrigins` | `chrome-extension://*` (any extension origin; unpacked Attention ids differ per install — decision PS-D6). `init --allow-origin chrome-extension://<Attention id>` pins it. Websites (`http(s)://` origins) are refused unless listed |
| `admin.listen`, `admin.auth` | `127.0.0.1:3871`, `local` (telemetry pages; [TrustGraph telemetry.md](../../TrustGraph/specs/telemetry.md)) |
| Guardrails | The shared defaults of [resolver-api.md § Guardrails](../../TrustGraph/specs/resolver-api.md#guardrails); memory limits in [architecture.md § Guardrails](architecture.md#guardrails) |

## Data directory

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\DigitalTrust\PersonalServer` |
| macOS | `~/Library/Application Support/DigitalTrust/PersonalServer` |
| Linux | `$XDG_DATA_HOME/digitaltrust/personal-server` (default `~/.local/share/…`) |

Contents: `config.json`, `personal.sqlite` (+ WAL files), `server.key`,
`logs/`. Owner-only permissions ([security.md](security.md)).

## Logging

Console plus rotating files (10 × 10 MB). Levels `error`, `warn`, `info`,
`debug`. Info never logs subjects or message bodies.

## Packaging

| Increment | Distribution |
| --- | --- |
| P1 | npm: `npx @dtp/personal-server init` |
| Later | Single executable (Node SEA) for Windows, macOS, Linux |
| Later | Run at login: `dtp-personal service install` (Windows Task Scheduler, launchd, systemd `--user`) |

## Health

NIP-11 document and `GET /healthz` / `GET /readyz` for clients; the
telemetry pages at `http://127.0.0.1:3871/` and `dtp-personal status` for
humans; `/metrics` on the same admin listener for Prometheus. A non-zero exit code means the database
could not be opened or the port could not be bound.
