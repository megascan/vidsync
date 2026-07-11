# VidSync — agent rules

Anonymous watch-party. **Primary client: Rust desktop** (`apps/host` → `vidsync`).

## Stack
- `apps/desktop` — **primary** Tauri 2 client (lobby + player + stream)
- `apps/site` — landing + R2 downloads Worker → `vidsync.ratt.ing`
- `workers/api` — CF Worker + Durable Object (`Room`) WebSocket hibernation
- `packages/shared` — protocol zod schemas (TS)
- `apps/web` / `apps/host` / `extensions` — legacy

## Rules
- bun workspaces for TS. TypeScript strict. No `any`.
- Host-authoritative sync. One DO per room code (`getByName`).
- Desktop-first: no browser required for create/join/play.
- Desktop create: header `X-VidSync-Client: desktop/<version>` (no Turnstile).
- Video: host serves local file or any http(s) URL in queue; peers play in system WebView (no mpv).
- Document decisions in `DOCS/`. Debt in `TECH_DEBT.md`.

## Commands
- `bun run dev:desktop` — Tauri desktop
- `cd apps/desktop && bun run tauri:build` — local installers
- `cd apps/site && bunx wrangler deploy` — landing (needs CF auth)
- `bun run dev:api` — wrangler DO local
- Prod: site `vidsync.ratt.ing`, API `api.vidsync.ratt.ing`
- CI: `.github/workflows/desktop-release.yml` → R2 + site

## Docs
- `DOCS/ci-release.md` — GH Actions + R2 secrets
- `DOCS/desktop.md` — desktop architecture
- `DOCS/sync-protocol.md` — wire protocol
