# VidSync Unblock

Optional Chromium extension. Lets [VidSync](https://vidsync.ratt.ing) fetch queue media **without page CORS**, using extension host permissions.

## What it does

- Runs **only** on `https://vidsync.ratt.ing` and local dev (`localhost:4321`)
- Page asks content script → background `fetch` (no CORS)
- Used for HLS segments / stubborn progressive streams
- **Does not** upload media to VidSync or Cloudflare
- **Does not** fix LAN reachability (remote friends still need a public URL)

## Install (unpacked)

1. Chrome/Edge → `chrome://extensions` → Developer mode
2. **Load unpacked** → select this folder (`extensions/vidsync-unblock`)
3. Open https://vidsync.ratt.ing — room UI should show **Unblock on**

Firefox: use temporary add-on load (`about:debugging`) with the same folder (MV3).

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
