# Architecture

## Domains
| Host | Unit |
|---|---|
| `https://vidsync.ratt.ing` | `apps/site` landing + R2 downloads |
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

Local: set `WEB_ORIGIN` in `workers/api/.dev.vars` if needed (desktop often uses no browser origin).

## Services
| Unit | Role | Deploy |
|---|---|---|
| `apps/desktop` | Tauri client (create/join/play/stream) | GH Actions → R2 installers |
| `apps/site` | Landing + download/updater JSON | `wrangler deploy` → `vidsync.ratt.ing` |
| `workers/api` | REST + WS → Room DO | `wrangler deploy` → `api.vidsync.ratt.ing` |
| `packages/shared` | Protocol types | consumed by API (+ TS clients) |

## Flow
1. Desktop `POST /rooms` (header `X-VidSync-Client: desktop/…`) → code + optional seed URL; init DO storage
2. Peers join via code; open WSS `/rooms/:code/ws` → DO hibernation WebSocket
3. Host mutates play/pause/seek/url; DO broadcasts `state`
4. Followers apply drift correction against expected position
5. Host may stream local file over LAN HTTP; peers play in system WebView

## Identity
- Room code: 8-char Crockford base32
- DO: `env.ROOMS.getByName(code)`
