# Tech debt

- Dev origins hardcoded-friendly: `WEB_ORIGIN=http://localhost:4321` in worker vars during local dev.
- No IP rate limiting yet beyond member cap — add CF rate-limit rules or Worker bucket before public launch.
- Static `/r/:code` needs deploy rewrite to `/room` — not wired until CF assets deploy config.
- Media CORS proxy not implemented; broken third-party URLs fail client-side only.
- Turnstile site key is a public client default in `astro.config.mjs` (fine). Secret lives in `workers/api/.dev.vars` (gitignored). Prod: `wrangler secret put TURNSTILE_SECRET_KEY`. Ensure Turnstile widget allows `localhost` + prod hostnames in CF dashboard.

