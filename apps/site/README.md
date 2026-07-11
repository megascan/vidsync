# VidSync site (landing + downloads)

Static download landing at **vidsync.ratt.ing**, with installers served from R2.

## Local

```bash
bun install
bunx wrangler dev
```

## Deploy

Requires R2 bucket `vidsync-releases` + CF API token (see `DOCS/ci-release.md`).

```bash
bunx wrangler deploy
```

CI deploys automatically from `.github/workflows/desktop-release.yml`.
