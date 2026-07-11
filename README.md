# VidSync

Anonymous watch parties. **Desktop app** creates a lobby, streams a local file, keeps everyone in sync. Multiplayer state lives on Cloudflare (Durable Object).

**API:** `https://api.vidsync.ratt.ing`  
**Legacy web:** [https://vidsync.ratt.ing](https://vidsync.ratt.ing)

## Desktop (primary) — Tauri

```bash
cd apps/desktop
bun install
bun run tauri:dev
# ship: bun run tauri:build
```

- Create / join room (no browser tab)
- Host: stream a local video (HTTP + optional UPnP + public IP)
- Playback in-app (`<video>` via system WebView — no mpv)
- Host Play/Pause/seek syncs the room

See `apps/desktop/README.md` and `DOCS/desktop.md`.

## Monorepo

```
apps/desktop      Tauri 2 — primary client
apps/host         Legacy egui / CLI stream helper
workers/api       Worker + Room DO
packages/shared   Protocol (zod)
apps/web          Legacy browser lobby
extensions/       Legacy Unblock player
DOCS/
```

## Local API

```bash
bun install
bun run dev:api    # http://localhost:8787
# desktop: set API field to http://127.0.0.1:8787
```

## Deploy API

```bash
cd workers/api && bunx wrangler deploy
```

Desktop room create uses `X-VidSync-Client: desktop/…` (no Turnstile). Web create still needs captcha.
