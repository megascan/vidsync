# Tech debt

- **GH secrets for release CI:** `TAURI_SIGNING_PRIVATE_KEY` + R2 S3 trio only. Site Worker redeploy is manual (`wrangler deploy`) when site code changes — not CI.
- ~~R2 binary same-path overwrite + cache~~ fixed: versioned release filenames in CI (`…-0.1.3.exe`).
- Local overrides: api `workers/api/.dev.vars` (`WEB_ORIGIN`). Prod defaults: `vidsync.ratt.ing` / `api.vidsync.ratt.ing`.
- Desktop create skips Turnstile (`X-VidSync-Client: desktop/…`) — **need CF rate-limit / IP bucket** before abuse (same as member-cap gap).
- No IP rate limiting yet beyond member cap — add CF rate-limit rules or Worker bucket before public launch.
- Desktop player is a separate WebView window (not embedded in egui yet); host chrome controls IPC→DO; polish embed later.
- Linux: webkit2gtk-4.1 runtime; AppImage needs FUSE. DMABUF disabled by default for NVIDIA/Wayland — re-enable later if upstream stabilizes.
- Media CORS proxy not implemented; broken third-party URLs fail client-side only.
- LAN/http streams allowed in URL validation; mixed content may still fail for http media.
- Turnstile secret lives in `workers/api/.dev.vars` (gitignored). Prod: `wrangler secret put TURNSTILE_SECRET_KEY`. (Browser create path removed; desktop bypasses captcha.)
