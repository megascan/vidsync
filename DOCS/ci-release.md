# Desktop CI + R2 releases

On every push to `master` (when desktop/site change), GitHub Actions:

1. Builds **Windows** (NSIS + MSI) and **Linux** (AppImage + deb)
2. Uploads binaries to R2 bucket `vidsync-releases`
3. Writes `latest.json`
4. Deploys landing page Worker to **vidsync.ratt.ing**

Workflow: `.github/workflows/desktop-release.yml`

## One-time Cloudflare setup

### 1. Create R2 bucket

```bash
cd apps/site
bun install
bunx wrangler r2 bucket create vidsync-releases
```

### 2. API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token**

Permissions:

- Account → **Workers Scripts** → Edit  
- Account → **Workers R2 Storage** → Edit  
- Account → **Account Settings** → Read (if prompted)

Or use the “Edit Cloudflare Workers” template + add R2 edit.

### 3. GitHub secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID (Workers overview right sidebar) |

### 4. Domain

`vidsync.ratt.ing` is already on Worker `vidsync-web` (same name as old site).  
`bunx wrangler deploy` from `apps/site` replaces the old Astro site.

First deploy (local, after secrets/token in shell):

```bash
cd apps/site
bun install
bunx wrangler deploy
```

## URLs

| Path | Source |
|---|---|
| `https://vidsync.ratt.ing/` | Landing page |
| `https://vidsync.ratt.ing/latest.json` | Version + download paths (R2) |
| `https://vidsync.ratt.ing/downloads/windows/VidSync-windows-setup.exe` | R2 |
| `https://vidsync.ratt.ing/downloads/linux/VidSync-linux.AppImage` | R2 |

## Manual run

Actions → **Desktop release** → Run workflow.

## Notes

- Linux builds need Ubuntu webkit deps (installed in CI).  
- Windows artifacts: NSIS installer preferred on the landing card.  
- Build is size-optimized (`opt-level = "z"`, LTO) — CI takes longer.  
