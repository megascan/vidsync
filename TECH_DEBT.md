# Tech debt

- **GH secrets for release CI:** `TAURI_SIGNING_PRIVATE_KEY` + R2 S3 trio only. Site Worker: CF Git Builds on `apps/site` (or manual `wrangler deploy`).
- ~~R2 binary same-path overwrite + cache~~ fixed: versioned release filenames + head-object refuse + run_attempt version bump.
- Local overrides: api `workers/api/.dev.vars` (`WEB_ORIGIN`). Prod defaults: `vidsync.ratt.ing` / `api.vidsync.ratt.ing`.
- Desktop create skips Turnstile (`X-VidSync-Client: desktop/…`) — **need CF rate-limit / IP bucket** before abuse (same as member-cap gap).
- No IP rate limiting yet beyond member cap — add CF rate-limit rules or Worker bucket before public launch.
- Linux: webkit2gtk-4.1 runtime; AppImage needs FUSE. DMABUF disabled by default for NVIDIA/Wayland — re-enable later if upstream stabilizes.
- Media CORS proxy not implemented; broken third-party URLs fail client-side only.
- LAN/http streams allowed in URL validation; mixed content may still fail for http media.
- Turnstile secret lives in `workers/api/.dev.vars` (gitignored). Prod: `wrangler secret put TURNSTILE_SECRET_KEY`. (Browser create path removed; desktop bypasses captcha.)
- **UPnP renew timer:** lease is 3600s but no mid-session renew yet — long rooms can lose WAN after 1h if router drops expired maps. Add renew loop on MediaHub.
- **Wire protocol triple-mirror:** `packages/shared` (zod) + Rust `protocol.rs` + hand-copied TS types in `main.ts`. `transfer_host` exists server-side + zod, no desktop UI. Generate or CI-check the mirror.
- **`room_closed` / `dissolveRoom`:** dead protocol path (empty wipe deletes without notifying). Wire for abuse/takedown or delete both sides.
- **Authenticode:** Windows installers unsigned → SmartScreen on every download until cert lands.
- **macOS desktop build:** landing shows unsupported; no CI target yet.
