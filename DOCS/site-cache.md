# Site Worker cache (`vidsync-web`)

Workers Cache sits **in front of** the Worker. On HIT the edge returns the stored
response and **does not run** `worker.ts` (no R2 read, no CPU bill beyond request).

Enabled in `apps/site/wrangler.jsonc`:

```jsonc
"cache": { "enabled": true }
```

Zone Cache Rules / Page Rules **do not** apply. Only response `Cache-Control`
(+ tags) configure behavior.

## Endpoints

| Path | Source | `Cache-Control` | `Cache-Tag` |
|---|---|---|---|
| `/latest.json` | R2 `latest.json` | `public, max-age=60` | `vidsync-json`, `r2:latest.json` |
| `/updater.json` | R2 `updater.json` | `public, max-age=60` | `vidsync-json`, `r2:updater.json` |
| `/downloads/*` versioned (`-0.1.3.`) | R2 | `public, max-age=31536000, immutable` | `vidsync-download`, `r2:<key>` |
| `/downloads/*` legacy unversioned | R2 | `public, max-age=0, must-revalidate` | same |
| `/downloads/*` Range | R2 ranged get | `public, max-age=3600` (206 not stored long) | same tags |
| HTML (`/`, `*.html`) | ASSETS | `public, max-age=60` | `vidsync-asset` |
| CSS/JS | ASSETS | `public, max-age=300` | `vidsync-asset` |
| R2 404 | — | `public, max-age=30` | path tags |

Binaries cache **1 day** because CI overwrites fixed names
(`VidSync-windows-setup.exe`). After versioned URLs land, switch to
`max-age=31536000, immutable`.

### Same-key overwrite

1. **Versioned URLs** in `latest.json` / `updater.json` — best long-term.
2. **Purge** by tag after publish (`vidsync-json`, `r2:downloads/...`, or `vidsync-download`).
3. Current 1-day TTL bounds staleness without purge.

JSON manifests cache **60s** so landing + updater refresh quickly.

## Verify

```bash
# MISS then HIT
curl -sI https://vidsync.ratt.ing/latest.json | grep -i cf-cache-status
curl -sI https://vidsync.ratt.ing/latest.json | grep -i cf-cache-status
# expect: MISS then HIT (or EXPIRED / REVALIDATED)
```

Other statuses: `UPDATING`, `STALE`, `BYPASS` — see CF cache response docs.

## Purge (optional)

Workers Cache purge API (account token) or from a Worker with `ctx.exports` /
`cache.purge({ tags: [...] })` if wired later.

Tags to purge after release:

- `vidsync-json` — both manifests
- `r2:downloads/windows/VidSync-windows-setup.exe` — one installer
- `vidsync-download` — all installers

## Deploy

```bash
cd apps/site
bunx wrangler deploy
```

Not part of desktop-release CI (R2 S3 only). Deploy when site/worker changes.
