# VidSync Unblock (browser extension)

Optional Chromium/Firefox MV3 extension. **No Cloudflare media proxy.**

## Role
- Room DO still syncs playhead only
- Extension fetches queue media with host permissions (no page CORS)
- Page never gets `chrome.*`; bridge is `window.postMessage` + content script

## Paths
| Media | Without extension | With extension |
|---|---|---|
| Progressive MP4/WebM | `<video src>` direct | same, then blob via Unblock on error (≤80MB) |
| HLS | hls.js / native (needs CORS) | hls.js custom loader → extension fetch per segment |

## Security
- Content script only on `vidsync.ratt.ing` + localhost:4321
- Background rejects messages not from extension id + those page origins
- Strips Cookie / Authorization from forwarded headers
- No upload of bodies to VidSync servers

## Install
See `extensions/vidsync-unblock/README.md` (load unpacked).

## Limits
- Full-buffer progressive max 80 MiB (use HLS or direct for larger)
- Does not make private LAN URLs reachable to remote peers
