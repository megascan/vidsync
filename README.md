# VidSync

Anonymous watch parties for **raw HTTPS video stream URLs**. Host controls playback; everyone stays in sync.

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

| Var | Where | Default |
|---|---|---|
| `PUBLIC_API_URL` | web | `http://localhost:8787` |
| `WEB_ORIGIN` | worker | `http://localhost:4321` |

## CORS reality

Browsers fetch media **directly**. Sources need CORS (and Range for progressive). VidSync does not proxy video.

## Deploy

1. `cd workers/api && bunx wrangler deploy`  
2. `cd apps/web && bun run build` → host `dist/` as static assets  
3. Rewrite `/r/*` → `/room` (200) — see `public/_redirects`  
4. Set `WEB_ORIGIN` + `PUBLIC_API_URL` to production URLs
