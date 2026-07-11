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

### 4. Landing Worker deploy (CF Git Builds)

**Worker:** `vidsync-web` · **path:** `apps/site`

Dashboard → Worker → Settings → Builds:

| Field | Value |
|---|---|
| **Root directory** | `apps/site` |
| **Build command** | leave empty, or `npm install` / `bun install` |
| **Deploy command** | `npx wrangler deploy` |
| **Version command** (preview) | `npx wrangler versions upload` |

Manual:

```bash
cd apps/site
bun install
bunx wrangler deploy
```

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
| `https://vidsync.ratt.ing/downloads/windows/VidSync-windows-setup-{ver}.exe` | R2 (+ `.sig`) — **versioned** |
| `https://vidsync.ratt.ing/downloads/linux/VidSync-linux-{ver}.AppImage` | R2 (+ `.sig`) — **versioned** |

Unversioned keys caused Workers Cache to serve a stale installer body against a
new minisign signature → **signature verification failed** on auto-update.

### `updater.json` shape (Tauri static)

Plugin ≥2.10 looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`.

```json
{
  "version": "0.1.2",
  "notes": "VidSync 0.1.2",
  "pub_date": "2026-…",
  "platforms": {
    "windows-x86_64-nsis": {
      "url": "https://vidsync.ratt.ing/downloads/windows/VidSync-windows-setup-{ver}.exe",
      "signature": "<contents of .sig>"
    },
    "windows-x86_64": {
      "url": "https://vidsync.ratt.ing/downloads/windows/VidSync-windows-setup-{ver}.exe",
      "signature": "<contents of .sig>"
    },
    "linux-x86_64-appimage": {
      "url": "https://vidsync.ratt.ing/downloads/linux/VidSync-linux-{ver}.AppImage",
      "signature": "<contents of .sig>"
    },
    "linux-x86_64": {
      "url": "https://vidsync.ratt.ing/downloads/linux/VidSync-linux-{ver}.AppImage",
      "signature": "<contents of .sig>"
    },
    "linux-x86_64-deb": {
      "url": "https://vidsync.ratt.ing/downloads/linux/VidSync-linux-{ver}.deb",
      "signature": "<contents of .sig>"
    }
  }
}
```

Built by `apps/site/scripts/make-updater.mjs` in CI.

**Linux .deb installs need `linux-x86_64-deb`.** Without it, a deb install downloads
the AppImage URL, then `install_deb()` rejects non-deb bytes with
`invalid updater binary format`. AppImage installs use `linux-x86_64-appimage` /
legacy `linux-x86_64`.

## In-app flow

On launch, desktop calls `@tauri-apps/plugin-updater` `check()` against `/updater.json`.
If remote version > installed, banner: **Install & restart** → download + verify signature → install → relaunch.

## Versioning

Each CI build runs `apps/desktop/scripts/sync-version.mjs --ci` before `tauri build`:

- Reads base from `package.json` (e.g. `0.1.3`)
- Sets release version to `0.1.max(patch+1, GITHUB_RUN_NUMBER)`
- Writes the same value into `package.json`, `Cargo.toml`, `tauri.conf.json`
- Publish stages use that baked `VERSION` file (not the clean checkout)

So every successful release is a **new, higher** semver. Local dev keeps committed `package.json` until you run:

```bash
cd apps/desktop
node scripts/sync-version.mjs --set 0.2.0
```

## Manual run

Actions → **Desktop release** → Run workflow.

## Notes

- Linux builds need Ubuntu webkit deps (installed in CI).  
- Windows artifacts: NSIS installer preferred (landing + updater).  
- Build is size-optimized (`opt-level = "z"`, LTO) — CI takes longer.  
- Without `TAURI_SIGNING_PRIVATE_KEY`, `createUpdaterArtifacts: true` build fails.  
