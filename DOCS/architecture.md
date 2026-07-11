# Architecture

## Domains
| Host | Unit |
|---|---|
| `https://vidsync.ratt.ing` | `apps/web` static |
| `https://api.vidsync.ratt.ing` | `workers/api` |

CORS allowlist: `WEB_ORIGIN=https://vidsync.ratt.ing`

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
Pure static cannot prerender infinite codes. Deploy rewrite:
`/r/*` → `/room/index.html` (200). Island parses code from pathname.
