# VidSync Unblock (browser extension)

Optional Chromium MV3 extension. **No Cloudflare media proxy. No same-page CORS hacks for multi‑GB files.**

## Architecture

```
Room tab (vidsync.ratt.ing)          = LOBBY
  ├─ DO WebSocket (sync authority client)
  ├─ Queue / chat / members
  └─ postMessage ↔ content ↔ background
                                      │
Extension player popup                = MEDIA + HOST CONTROLS
  chrome-extension://…/player.html
  <video src=streamUrl>  ← Range stream (host_permissions)
  play/pause/seek (native) → player_user_control
      → room tab (if host) → DO play|pause|seek
  ticks → host heartbeat while playing
```

| Surface | Role |
|---|---|
| Room tab | Lobby: join, queue, chat, WS. Not primary transport controls in Unblock mode. |
| Extension player | Streams video; **host** chrome controls drive room state |

## Why a separate window

Loading a cross-origin multi‑GB URL **inside** the VidSync page still hits CORS for many CDNs.  
An **extension page** can set `<video src="https://…">` with host permissions and the browser streams via **HTTP Range** without the page origin involved.

## Control path (v2.1+)

1. Host opens **Stream with Unblock** → player window + room enters lobby mode  
2. Host play/pause/seek in player → `player_user_control` → room tab → DO  
3. Followers: room pushes `player_state` into their player (if open)  
4. Host ticks feed heartbeat position; room does **not** echo full state back to host player (avoids fighting native controls)

## User flow

1. Install unpacked `extensions/vidsync-unblock`, reload tab  
2. Queue a stream URL in the room  
3. Click **Stream with Unblock** → popup player opens  
4. Keep the room tab open (lobby/sync); watch + control in the popup  

## Limits

- Origin must support Range for progressive MP4  
- Each peer must reach the URL (LAN still LAN-only)  
- Autoplay may require one click in the player window  
- Reload extension after pull (manifest **2.1.0**)

## Files

- `background.js` — open/focus player, relay ticks + user_control  
- `player.html` / `player.js` — video + host control emit + apply sync  
- `content.js` — page bridge  
- Site: `apps/web/src/lib/unblock/bridge.ts`, `RoomApp.tsx`
