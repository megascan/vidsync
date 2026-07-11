# Architecture

## Domains
| Host | Unit |
|---|---|
| `https://vidsync.ratt.ing` | `apps/web` static |
| `https://api.vidsync.ratt.ing` | `workers/api` |

## CORS / Origin

| Rule | Behavior |
|---|---|
| Allowlist | `WEB_ORIGIN` comma-separated origins (default `https://vidsync.ratt.ing`) |
| ACAO | Echo request `Origin` **only if** on allowlist — never reflect arbitrary Origin |
| Disallowed | No `Access-Control-Allow-Origin`; preflight → 403 |
| Preflight | `OPTIONS` → 204; methods `GET, HEAD, POST, OPTIONS`; header `Content-Type` only |
| Credentials | Not used (no cookies); no `Allow-Credentials` |
| Local twins | `localhost` ↔ `127.0.0.1` same port auto-expanded |
| WebSocket | Not CORS, but `Origin` checked against same allowlist when present (CSWSH) |

Local: `WEB_ORIGIN=http://localhost:4321` in `.dev.vars`.

## Services
| Unit | Role | Deploy |
|---|---|---|
| `apps/web` | Astro static UI | CF Workers assets → `vidsync.ratt.ing` |
| `workers/api` | REST + WS → Room DO | `wrangler deploy` → `api.vidsync.ratt.ing` |
| `packages/shared` | Protocol types | consumed by both |

## Flow
1. `POST /rooms` → code + optional seed URL; init DO storage
2. Browser opens `/r/:code` (rewrite → `/room`) → React island
3. Island `GET/WSS /rooms/:code/ws` → DO hibernation WebSocket
4. Host mutates play/pause/seek/url; DO broadcasts `state`
5. Followers apply drift correction against expected position

## Identity
- Room code: 8-char Crockford base32
- DO: `env.ROOMS.getByName(code)`

## Static room routes
Pure static cannot prerender infinite codes. `apps/web/src/asset-worker.ts`:
- `run_worker_first: ["/r/*"]`
- Internal `ASSETS.fetch("/room/")` — **no browser 3xx** (redirects drop the code)
- Client parses code from pathname `/r/XXXXXXXX`
