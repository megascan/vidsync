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
| Linux | webkit2gtk-4.1 (system) |

### Linux crashes / blank window

WebKitGTK + NVIDIA/Wayland often dies on DMABUF. `main.rs` sets before webview:

| Env | Default |
|---|---|
| `WEBKIT_DISABLE_DMABUF_RENDERER` | `1` |
| `__NV_DISABLE_EXPLICIT_SYNC` | `1` |

Still broken? Try:

```bash
export WEBKIT_DISABLE_COMPOSITING_MODE=1
# or force X11:
export VIDSYNC_FORCE_X11=1
./VidSync-linux.AppImage
```

**AppImage:** `chmod +x`, needs FUSE (or extract: `./VidSync-linux.AppImage --appimage-extract-and-run`).

**Deb deps:** `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`.

### Join while media playing

WebKitGTK can crash if `app.innerHTML = …` destroys a loading/playing `<video>`.
UI always **detaches** the video element before paint, mounts into `#videoMount`
before load, seeks only after metadata, and serializes applyState generations.

### Linux “won't play” video

System WebView = **WebKitGTK + GStreamer**, not full FFmpeg. Prefer:

- Container: **MP4**
- Video: **H.264 (yuv420p)**
- Audio: **AAC**

Stream URLs include the file name + extension (`/s/{token}/name.mp4`) so GStreamer
can pick a demuxer. Extension-less URLs often fail on Linux while Windows works.

Extra tracks (e.g. QuickTime **tmcd** timecode) can confuse demuxers. Remux clean:

```bash
ffmpeg -i in.mp4 -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart out.mp4
```
