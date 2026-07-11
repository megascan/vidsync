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
| `vidsync-host` / `gui` | egui window: file picker, start/stop, copy URLs, install Unblock |
| `vidsync-host serve <file>` | Headless: bind HTTP, print LAN (+ WAN if UPnP), Ctrl+C cleans map |
| `vidsync-host install-ext` | Stage `vidsync-unblock` + optional `--load-extension` launch |

## GUI stack

`eframe`/`egui` + `rfd` native dialog. Server runs on a dedicated Tokio worker thread (`session::ServeSession`).

## URL shape

```
http://{lan|wan}:{port}/s/{token}
```

Token is random (not filesystem paths). Single file only.

## UPnP (and why it fails)

- Crate: `igd-next` async Tokio  
- SSDP discover → `add_port` / `add_any_port`  
- Lease `0` = until process exit; always `remove_port` on shutdown  
- Search binds LAN iface first, then `0.0.0.0`, longer timeouts  

### Error: `No response within timeout`

Router never answered multicast discovery. **Not** “port map rejected” — discovery itself died.

Typical:

| Cause | What happens |
|---|---|
| UPnP/IGD off | ISP/home routers ship it disabled |
| CGNAT / double NAT | ISP already NATs you; home UPnP only maps inside their net |
| VPN / corporate Wi‑Fi | Multicast blocked or wrong gateway |
| Guest Wi‑Fi / AP isolation | Client can't talk to gateway SSDP |
| Multi-homed PC | SSDP on wrong NIC (we try LAN bind first) |

### How games actually connect (not “magic UPnP”)

Modern multiplayer almost never depends on “host opens TCP port on home router”:

1. **Dedicated / matchmaking servers** — both clients dial *out* to a public host (easiest NAT path).
2. **STUN** — learn “what public IP:port does the world see me as?”
3. **UDP hole punching** — both peers send UDP toward each other so each NAT opens a temporary mapping. Works for many home NATs; fails on symmetric NAT.
4. **Relay / TURN** (Steam Datagram Relay, Xbox/PSN relays, Discord, WebRTC TURN) — if punch fails, traffic goes through a cloud box. Expensive bandwidth, works almost always.
5. **UPnP / NAT-PMP / PCP** — *optional* attempt to open a real inbound port. Nice when it works; games treat it as bonus, not the only path.

VidSync Host serves **HTTP TCP** (Range video). TCP hole punching is unreliable; a multi‑GB stream through a free TURN relay is painful. So UPnP/manual forward/tunnel is the honest toolkit — not game-style UDP P2P.

### Workarounds when UPnP times out

1. **Same LAN** — share the LAN URL only (friends on same Wi‑Fi).  
2. **Manual port forward** — router admin → TCP → PC:port, use public IP + that port.  
3. **Tunnel** — `cloudflared tunnel`, ngrok, Tailscale Funnel, playit.gg: outbound-only, no UPnP.  
4. **Enable UPnP** on router (if you trust LAN devices), disable VPN, retry.

## Extension

Cannot force-install unpacked MV3 for normal Chrome users. App copies extension to app-data and:

1. Launches browser with `--load-extension=<dir>` (session), and/or  
2. Prints Load unpacked path  

## Stack

Rust 2021, axum 0.8, clap, igd-next, local-ip-address, arboard.
