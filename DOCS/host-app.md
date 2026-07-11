# VidSync Host (`apps/host`)

Desktop CLI (`vidsync-host`) for sharing a **local file** as an HTTP stream URL for VidSync rooms.

## Why

VidSync only syncs **URLs** — it does not upload media. Hosts with a file on disk need:

1. HTTP server with **Range** (seek)
2. Optional **UPnP** so remote friends can reach it without manual router config
3. Optional **Unblock extension** install helper (Chromium CORS / multi‑GB)

## Commands

| Command | Role |
|---|---|
| `vidsync-host serve <file>` | Bind HTTP, print LAN (+ WAN if UPnP), Ctrl+C cleans map |
| `vidsync-host install-ext` | Stage `vidsync-unblock` + optional `--load-extension` launch |

## URL shape

```
http://{lan|wan}:{port}/s/{token}
```

Token is random (not filesystem paths). Single file only.

## UPnP

- Crate: `igd-next` async Tokio  
- `add_port` same port, else `add_any_port`  
- Lease `0` = until process exit; always `remove_port` on shutdown  

## Extension

Cannot force-install unpacked MV3 for normal Chrome users. App copies extension to app-data and:

1. Launches browser with `--load-extension=<dir>` (session), and/or  
2. Prints Load unpacked path  

## Stack

Rust 2021, axum 0.8, clap, igd-next, local-ip-address, arboard.
