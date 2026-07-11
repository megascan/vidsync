# VidSync desktop

Primary client is the **Rust app** (`apps/host` → binary `vidsync`).

## Stack

- egui UI (create/join lobby, queue, chat, host controls)
- WebSocket sync → `workers/api` Room Durable Object (same protocol as web)
- Local HTTP Range server + UPnP + public IP probe
- **mpv** external player (IPC) — no page CORS, no extension

## Auth / create

| Client | Create room |
|---|---|
| Web | Turnstile required |
| Desktop | `X-VidSync-Client: desktop/<ver>` skips captcha |

WS with no `Origin` is allowed (see `isWebSocketOriginOk`).

## Deprecations

- `apps/web` — legacy lobby (optional)
- `extensions/vidsync-unblock` — legacy CORS player for browser

## Run

```bash
cd apps/host && cargo run --release
```
