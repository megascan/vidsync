# VidSync Desktop (Tauri 2)

Cross-platform desktop client: **lobby + embedded player + local file stream** in one window.

- **UI:** Vite + TypeScript (system WebView)
- **Core:** Rust — DO sync, HTTP Range server, UPnP, public IP
- **No** browser extension, **no** mpv install

## Dev

```bash
cd apps/desktop
bun install
bun run tauri:dev
```

Or from repo root: `bun run dev:desktop`

## Build installers

```bash
cd apps/desktop
bun run tauri:build
# artifacts under src-tauri/target/release/bundle/
```

## Flow

1. Create / join room (API `https://api.vidsync.ratt.ing`)
2. Host: **Stream local file…**
3. Everyone watches in the in-app `<video>` player
4. Host play/pause/seek (player chrome or buttons) sync via Durable Object

## Platforms

| OS | Notes |
|---|---|
| Windows | WebView2 |
| macOS | WKWebView |
| Linux | webkit2gtk system package |
