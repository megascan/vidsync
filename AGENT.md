# VidSync — agent rules

Anonymous watch-party. **Primary client: Rust desktop** (`apps/host` → `vidsync`).

## Stack
- `apps/host` — Rust desktop: lobby, DO sync, local HTTP stream, UPnP, native WebView player
- `workers/api` — CF Worker + Durable Object (`Room`) WebSocket hibernation
- `packages/shared` — protocol zod schemas (TS); Rust mirrors in `apps/host/src/protocol.rs`
- `apps/web` — **legacy** Astro lobby (optional)
- `extensions/vidsync-unblock` — **legacy** browser CORS player

## Rules
- bun workspaces for TS. TypeScript strict. No `any`.
- Host-authoritative sync. One DO per room code (`getByName`).
- Desktop-first: no browser required for create/join/play.
- Desktop create: header `X-VidSync-Client: desktop/<version>` (no Turnstile).
- Video: host serves local file or any http(s) URL in queue; peers play in system WebView (no mpv).
- Document decisions in `DOCS/`. Debt in `TECH_DEBT.md`.

## Commands
- `cd apps/host && cargo run --release` — desktop GUI
- `bun run dev:api` — wrangler DO local
- `bun run dev:web` — legacy web (optional)
- Prod API: `https://api.vidsync.ratt.ing`
- Turnstile only for web create

## Docs
- `DOCS/desktop.md` — desktop architecture
- `DOCS/host-app.md` — stream / UPnP notes
- `DOCS/sync-protocol.md` — wire protocol
