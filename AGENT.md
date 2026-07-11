# VidSync — agent rules

Anonymous watch-party: rooms sync raw video stream URLs.

## Stack
- `apps/web` — Astro 7 static, React islands, Tailwind v4, Zustand
- `workers/api` — CF Worker + Durable Object (`Room`) WebSocket hibernation
- `packages/shared` — protocol zod schemas + types (single source of truth)

## Rules
- bun workspaces. TypeScript strict. No `any`.
- Frontend/backend always separate. No Astro CF adapter (static only).
- Host-authoritative sync. One DO per room code (`getByName`).
- Video: http(s) URLs (LAN ok). No CF media proxy — optional `extensions/vidsync-unblock`.
- No auth MVP.
- Document decisions in `DOCS/`. Debt in `TECH_DEBT.md`.
- Public copy → de-slop before ship.

## Commands
- `bun run dev:web` — Astro
- `bun run dev:api` — wrangler dev (DO local)
- Prod: web `https://vidsync.ratt.ing`, API `https://api.vidsync.ratt.ing`
- `PUBLIC_API_URL` web, `WEB_ORIGIN` worker (prod defaults; local via `.env` / `.dev.vars`)
- Turnstile: `PUBLIC_TURNSTILE_SITE_KEY` (web), `TURNSTILE_SECRET_KEY` in `workers/api/.dev.vars` (never commit)
- Create room requires captcha; join does not

## Room URL
Pretty `/r/:code` via `apps/web/src/asset-worker.ts` (see DOCS/architecture.md).

## Extension
`extensions/vidsync-unblock` — MV3, load unpacked. Bridge: `apps/web/src/lib/unblock/`.
