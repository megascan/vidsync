# VidSync desktop

Primary client: **Tauri 2** app in `apps/desktop`.

## Stack

| Layer | Tech |
|---|---|
| Shell | Tauri 2 (system WebView) |
| UI | Vite + TypeScript — lobby + embedded `<video>` |
| Core | Rust — DO sync, HTTP Range server, UPnP, public IP |
| Multiplayer | `workers/api` Room Durable Object (unchanged) |

No browser extension. No mpv download. Codecs = OS media stack.

## Dev / ship

```bash
cd apps/desktop
bun install
bun run tauri:dev      # hot reload
bun run tauri:build    # MSI / DMG / AppImage etc.
```

Root: `bun run dev:desktop` · `bun run build:desktop`

## Auth / create

| Client | Create room |
|---|---|
| Web | Turnstile required |
| Desktop | `X-VidSync-Client: desktop/…` skips captcha |

WS with no `Origin` is allowed.

## Layout

```
apps/desktop/
  src/                 frontend (main.ts, styles)
  src-tauri/
    src/
      lib.rs           Tauri commands + events
      sync.rs api.rs   DO client
      session.rs …     file server + UPnP
    tauri.conf.json
```

## Events

Rust emits `sync-event` (welcome / state / members / chat / …).  
UI invokes `room_create`, `room_join`, `stream_start`, `host_play`, …

## Legacy

- `apps/host` — earlier egui experiments  
- `apps/web` + `extensions/` — browser path  

## Platforms

| OS | WebView |
|---|---|
| Windows | WebView2 |
| macOS | WKWebView |
| Linux | webkit2gtk (system package) |
