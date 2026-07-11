# VidSync desktop (`vidsync`)

Self-contained watch party: **create/join lobby**, **stream a local file** (HTTP + UPnP + public IP), **sync via Cloudflare Room DO**, play in a **native system WebView** window.

No browser lobby. No Chromium extension. **No mpv / ffmpeg install.**

## Build / run

```bash
cd apps/host
cargo run --release
# target/release/vidsync.exe  (Windows)
```

Needs network to `https://api.vidsync.ratt.ing` (or set API to local wrangler).

### Platform player backend

| OS | Engine | Notes |
|---|---|---|
| Windows | **WebView2** | Ships with modern Windows / Edge |
| macOS | **WKWebView** | Built into the OS |
| Linux | **WebKitGTK** | Distro package e.g. `webkit2gtk-4.1` (system lib, not a user “download app”) |

Codecs = whatever the OS media stack already supports (H.264 etc.).

## GUI flow

1. Nickname → **Create room** (share code)  
2. Host: **Stream local file…**  
3. Friends: **Join** with code  
4. Video in the **VidSync Player** window (system WebView)  
5. Host play/pause in player or lobby buttons → room sync  

## CLI

```bash
cargo run --release -- serve ./movie.mp4   # headless file server only
```

## Modules

| File | Role |
|---|---|
| `gui.rs` | Lobby UI |
| `sync.rs` | WebSocket → Room DO |
| `player.rs` | Native WebView player |
| `server.rs` / `session.rs` / `upnp.rs` | File stream + port map |
