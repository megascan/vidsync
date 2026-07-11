# VidSync Unblock

Optional Chromium extension. Lets [VidSync](https://vidsync.ratt.ing) fetch queue media **without page CORS**, using extension host permissions.

## What it does

- Runs **only** on `https://vidsync.ratt.ing` and local dev (`localhost:4321`)
- **Streaming CORS shim** (`declarativeNetRequest`): adds `Access-Control-*` +
  `Accept-Ranges` on media/XHR when initiated by VidSync so the **browser** can
  Range-stream multi‑GB progressive MP4 (no full download)
- **HLS**: segment loader / page XHR works under the same shim
- **Fetch bridge**: only small bodies (segments / files ≤32MB) — **never** whole movies
- Room button **Stream with Unblock** enables shim + reloads for Range streaming
- **Does not** upload media to VidSync or Cloudflare
- **Does not** fix LAN reachability (remote friends still need a public URL)

## Install (unpacked)

1. Chrome/Edge → `chrome://extensions` → Developer mode
2. **Load unpacked** → select this folder (`extensions/vidsync-unblock`)
3. **Reload** any open VidSync tab (required after install/update)
4. Open https://vidsync.ratt.ing — you should see:
   - Home: green **Unblock active** banner
   - Room: **Unblock on** pill + short toast
   - Extension icon badge **ON** on that tab

### Why the toolbar popup doesn’t open by itself

Chrome blocks extensions from auto-opening their popup when you visit a site.
Click the puzzle piece / Unblock icon if you want the popup. Day-to-day, the
**site UI** is the interaction surface.

Firefox: temporary add-on via `about:debugging` (MV3).

## Permissions

| Permission | Why |
|---|---|
| `*://*/*` host | Fetch media URLs the host queues (any CDN) |
| `storage` | Reserved / future prefs |

Only VidSync origins can talk to the bridge.

## Privacy

- Fetches URLs **you** (or the room host) put in the queue
- Response bodies go to the VidSync page in your browser only
- No analytics, no account

## Dev

Site dev: `bun run dev:web` on port 4321 (allowlisted).  
No build step — plain JS for easy unpacked loads.
