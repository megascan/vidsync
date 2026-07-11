# Tech debt

- Local overrides: web `apps/web/.env`, api `workers/api/.dev.vars` (WEB_ORIGIN). Prod defaults: `vidsync.ratt.ing` / `api.vidsync.ratt.ing`.
- Desktop create skips Turnstile (`X-VidSync-Client: desktop/…`) — **need CF rate-limit / IP bucket** before abuse (same as member-cap gap).
- No IP rate limiting yet beyond member cap — add CF rate-limit rules or Worker bucket before public launch.
- Desktop player is a separate WebView window (not embedded in egui yet); host chrome controls IPC→DO; polish embed later.
- Linux needs webkit2gtk system package for WebView (documented, not an end-user “download app”).
- Web + Unblock extension are legacy paths; remove when desktop is default for all users.
- Static `/r/:code` needs deploy rewrite to `/room` — not wired until CF assets deploy config.
- Media CORS proxy not implemented; broken third-party URLs fail client-side only.
- LAN/http streams allowed in URL validation; mixed content (https site → http media) may still fail in browser — host over https CDN or use same-origin proxy later.
- Turnstile site key is a public client default in `astro.config.mjs` (fine). Secret lives in `workers/api/.dev.vars` (gitignored). Prod: `wrangler secret put TURNSTILE_SECRET_KEY`. Ensure Turnstile widget allows `localhost` + prod hostnames in CF dashboard.

