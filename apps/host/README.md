# VidSync desktop (`vidsync`)

Self-contained watch party app: **create/join lobby**, **stream a local file** (HTTP + UPnP + public IP), **sync via Cloudflare Room DO**, play in **mpv**.

No browser room tab. No Unblock extension for the happy path.

## Build / run

```bash
cd apps/host
cargo run --release
# binary: target/release/vidsync.exe
```

Needs network to `https://api.vidsync.ratt.ing` (or local API).  
**mpv** on PATH (or `mpv.exe` next to the binary) for video.

## GUI flow

1. Nickname → **Create room** (or Join with 8-char code)  
2. Host: **Stream local file…** → HTTP server + queue URL for room  
3. Everyone: video in **mpv**; host Play/Pause drives the room  
4. **Copy code** / **Copy URL** for friends  

## CLI (legacy / scripting)

```bash
cargo run --release -- serve ./movie.mp4
cargo run --release -- install-ext   # old web extension helper
```

## API

Desktop create uses header `X-VidSync-Client: desktop/0.2.0` (no Turnstile).  
Web create still requires captcha.

## Layout

| Module | Role |
|---|---|
| `gui.rs` | Home + room UI |
| `sync.rs` | WebSocket → Room DO |
| `api.rs` | REST create room |
| `player.rs` | mpv JSON IPC |
| `server.rs` / `session.rs` / `upnp.rs` | File stream + port map |
