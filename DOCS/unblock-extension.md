# VidSync Unblock (browser extension)

Optional Chromium MV3 extension. **No Cloudflare media proxy. No same-page CORS hacks for multi‑GB files.**

## Architecture

```
Room tab (vidsync.ratt.ing)
  ├─ DO WebSocket: play/pause/seek/chat/queue
  ├─ UI controls
  └─ postMessage → content script → background
                                      │
                                      ├─ opens player.html (popup window)
                                      │     chrome-extension://…/player.html
                                      │     <video src=streamUrl>  ← Range stream
                                      │     host_permissions = no page CORS
                                      │
                                      └─ relays sync both ways
```

| Surface | Role |
|---|---|
| Room tab | Sync authority client, queue, chat |
| Extension player window | Actual media playback (streaming) |

## Why a separate window

Loading a cross-origin multi‑GB URL **inside** the VidSync page still hits CORS for many CDNs.  
An **extension page** can set `<video src="https://…">` with host permissions and the browser streams via **HTTP Range** without the page origin involved.

## User flow

1. Install unpacked `extensions/vidsync-unblock`, reload tab  
2. Queue a stream URL in the room  
3. Click **Stream with Unblock** → popup player opens  
4. Keep the room tab open (sync); watch in the popup  

## Limits

- Origin must support Range for progressive MP4  
- Each peer must reach the URL (LAN still LAN-only)  
- Autoplay may require one click in the player window  

## Files

- `background.js` — open/focus player, relay messages  
- `player.html` / `player.js` — video element + apply sync  
- `content.js` — page bridge  
- Site: `apps/web/src/lib/unblock/bridge.ts`