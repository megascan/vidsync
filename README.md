# VidSync

Anonymous watch parties. **Desktop app** creates a lobby, streams a local file, keeps everyone in sync. Multiplayer state lives on Cloudflare (Durable Object).

**Site / downloads:** [https://vidsync.ratt.ing](https://vidsync.ratt.ing)  
**API:** `https://api.vidsync.ratt.ing`

## Desktop (primary)

```bash
cd apps/desktop
bun install
bun run tauri:dev
# ship: bun run tauri:build
```

Windows + Linux installers build on every `master` push and publish to R2 (landing at vidsync.ratt.ing).  
See `DOCS/ci-release.md`.

- Create / join room  
- Host streams a local file; room stays in sync  
- Native player (system WebView)

## Monorepo

```
apps/desktop      Tauri 2 client
apps/site         Landing + R2 download worker → vidsync.ratt.ing
workers/api       Room DO
packages/shared   Protocol
apps/host         Legacy egui / CLI
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

Desktop room create uses `X-VidSync-Client: desktop/…` (no Turnstile).
