# Desktop CI + R2 releases + auto-update

On every push to `master` (when desktop/site change), GitHub Actions:

1. Builds **Windows** (NSIS + MSI) and **Linux** (AppImage + deb)
2. Signs updater artifacts with minisign (`TAURI_SIGNING_PRIVATE_KEY`)
3. Uploads binaries + `.sig` to R2 bucket `vidsync`
4. Writes `latest.json` (landing) + `updater.json` (Tauri static endpoint)
5. Deploys landing Worker to **vidsync.ratt.ing**

Workflow: `.github/workflows/desktop-release.yml`

## One-time Cloudflare setup

### 1. Create R2 bucket

```bash
cd apps/site
bun install
bunx wrangler r2 bucket create vidsync
```

### 2. R2 S3 API token (binaries)

R2 → **Manage R2 API Tokens** → Create → Object Read & Write on `vidsync`.

Copy Access Key ID + Secret Access Key once (secret not shown again).

### 3. GitHub secrets (release CI)

| Secret | Value | Used for |
|---|---|---|
| `R2_ACCESS_KEY_ID` | R2 S3 access key | `aws s3 cp` uploads |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret | `aws s3 cp` uploads |
| `R2_ACCOUNT_ID` | CF account ID | endpoint `https://<id>.r2.cloudflarestorage.com` |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `.keys/vidsync.key` | sign installers |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | only if key has password | optional |

**No `CLOUDFLARE_API_TOKEN` in CI.** Releases only put objects in R2. Live Worker `vidsync-web` already binds that bucket and serves `/downloads/*`, `/latest.json`, `/updater.json` from R2 on each request — no redeploy for new builds.

### 4. When you *do* need wrangler (manual, rare)

Only if you change **Worker code** or **static landing** (`apps/site/src/worker.ts`, `public/*` HTML/CSS/JS):

```bash
cd apps/site
bunx wrangler deploy   # needs CF login / API token locally
```

That is Workers deploy API, not R2 S3. Not part of the release workflow.

### 5. Domain

`vidsync.ratt.ing` → Worker `vidsync-web` (R2 binding bucket `vidsync`).

## Updater signing keys

Keys already generated once (local `.keys/`, gitignored). Public key is embedded in
`apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.

**Never lose the private key.** Lose it → existing installs can't verify new updates;
you'd need a new keypair + force manual reinstall for all users.

Local regen (only if rotating):

```bash
cd apps/desktop
bunx tauri signer generate -w ../../.keys/vidsync.key --ci
# paste new .pub contents into tauri.conf.json plugins.updater.pubkey
# update GH secret TAURI_SIGNING_PRIVATE_KEY
```

Local signed build:

```bash
# PowerShell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ..\..\..\keys\vidsync.key -Raw
# or from repo root:
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .keys\vidsync.key -Raw
cd apps/desktop
bun run tauri:build
```

## URLs

| Path | Source |
|---|---|
| `https://vidsync.ratt.ing/` | Landing page |
| `https://vidsync.ratt.ing/latest.json` | Landing version + download paths |
| `https://vidsync.ratt.ing/updater.json` | **Tauri auto-update** static manifest |
| `https://vidsync.ratt.ing/downloads/windows/VidSync-windows-setup.exe` | R2 (+ `.sig`) |
| `https://vidsync.ratt.ing/downloads/linux/VidSync-linux.AppImage` | R2 (+ `.sig`) |

### `updater.json` shape (Tauri static)

```json
{
  "version": "0.1.2",
  "notes": "VidSync 0.1.2",
  "pub_date": "2026-…",
  "platforms": {
    "windows-x86_64": {
      "url": "https://vidsync.ratt.ing/downloads/windows/VidSync-windows-setup.exe",
      "signature": "<contents of .sig>"
    },
    "linux-x86_64": {
      "url": "https://vidsync.ratt.ing/downloads/linux/VidSync-linux.AppImage",
      "signature": "<contents of .sig>"
    }
  }
}
```

Built by `apps/site/scripts/make-updater.mjs` in CI.

## In-app flow

On launch, desktop calls `@tauri-apps/plugin-updater` `check()` against `/updater.json`.
If remote version > installed, banner: **Install & restart** → download + verify signature → install → relaunch.

## Manual run

Actions → **Desktop release** → Run workflow.

## Notes

- Linux builds need Ubuntu webkit deps (installed in CI).  
- Windows artifacts: NSIS installer preferred (landing + updater).  
- Build is size-optimized (`opt-level = "z"`, LTO) — CI takes longer.  
- Without `TAURI_SIGNING_PRIVATE_KEY`, `createUpdaterArtifacts: true` build fails.  
