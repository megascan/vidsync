# VidSync

Anonymous watch parties for **raw HTTPS video stream URLs**. Host controls playback; everyone stays in sync.

**Live:** [https://vidsync.ratt.ing](https://vidsync.ratt.ing) · API: `https://api.vidsync.ratt.ing`

- **Web:** Astro static + React island  
- **API:** Cloudflare Worker + Durable Object (WebSocket hibernation)  
- **Formats:** progressive MP4/WebM, HLS (`.m3u8` via hls.js)

## Monorepo

```
apps/web          Astro UI
workers/api       Worker + Room DO
packages/shared   Protocol (zod)
DOCS/             Architecture notes
```

## Local dev

```bash
bun install
bun run dev:api    # http://localhost:8787
bun run dev:web    # http://localhost:4321
```

Create a room on the home page, open the link in two browsers. Only the host can play/pause/seek/set URL.

### Env

| Var | Where | Prod | Local |
|---|---|---|---|
| `PUBLIC_API_URL` | web | `https://api.vidsync.ratt.ing` | `apps/web/.env` → `http://localhost:8787` |
| `PUBLIC_TURNSTILE_SITE_KEY` | web | site key (public) | same |
| `WEB_ORIGIN` | worker | `https://vidsync.ratt.ing` | `.dev.vars` → `http://localhost:4321` |
| `TURNSTILE_SECRET_KEY` | worker secret / `.dev.vars` | required | required |

Copy `workers/api/.dev.vars.example` → `.dev.vars` and set the Turnstile secret.  
Copy `apps/web/.env.example` → `.env` for local API URL.  
Production secret: `cd workers/api && bunx wrangler secret put TURNSTILE_SECRET_KEY`.

Create room requires Cloudflare Turnstile. Join by code does not.

## CORS reality

Browsers fetch media **directly**. Sources need CORS (and Range for progressive). VidSync does not proxy video.

## Deploy

Domains (Cloudflare custom domains on zone `ratt.ing`):

| Host | Service |
|---|---|
| `vidsync.ratt.ing` | static web (`apps/web`) |
| `api.vidsync.ratt.ing` | API Worker + DO |

```bash
# API
cd workers/api && bunx wrangler deploy

# Web
cd apps/web && bun run deploy
```

Turnstile dashboard: allow `vidsync.ratt.ing` (+ `localhost` for dev).  
`/r/*` pretty rooms: SPA `not_found_handling` on web worker assets + `public/_redirects`.
