# VidSync

Anonymous watch parties. **Desktop app** creates a lobby, streams a local file, keeps everyone in sync. Multiplayer state lives on Cloudflare (Durable Object).

**API:** `https://api.vidsync.ratt.ing`  
**Legacy web:** [https://vidsync.ratt.ing](https://vidsync.ratt.ing)

## Desktop (primary)

```bash
cd apps/host
cargo run --release
```

- Create / join room (no browser)
- Host: stream a local video (HTTP + optional UPnP + public IP)
- Playback in **mpv** (install [mpv](https://mpv.io) or drop `mpv.exe` next to the binary)
- Host Play/Pause syncs the room

See `apps/host/README.md` and `DOCS/desktop.md`.

## Monorepo

```
apps/host         Rust desktop (vidsync) — lobby + stream + mpv
workers/api       Worker + Room DO
packages/shared   Protocol (zod)
apps/web          Legacy browser lobby
extensions/       Legacy Unblock player (browser CORS)
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
