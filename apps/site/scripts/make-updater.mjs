#!/usr/bin/env node
/**
 * Build Tauri static updater.json from staged installers + .sig files.
 * Usage: node make-updater.mjs <stageDir> <version> [baseUrl]
 *
 * Versioned paths only (avoids Workers Cache serving stale body vs new sig).
 *
 * Platform keys (tauri-plugin-updater ≥2.10):
 *   Prefer `{os}-{arch}-{installer}` so each install format gets the right
 *   binary. Fallback `{os}-{arch}` kept for older clients.
 *
 *   linux-x86_64-appimage / linux-x86_64 → AppImage
 *   linux-x86_64-deb → .deb
 *   windows-x86_64-nsis / windows-x86_64 → NSIS setup.exe
 *
 * Without the -deb key, a .deb install downloads AppImage → install_deb() →
 * "invalid updater binary format".
 */
import fs from "node:fs";
import path from "node:path";

const [stageDir, version, baseUrlArg] = process.argv.slice(2);
if (!stageDir || !version) {
  console.error("usage: make-updater.mjs <stageDir> <version> [baseUrl]");
  process.exit(1);
}

const baseUrl = (baseUrlArg || "https://vidsync.ratt.ing").replace(/\/$/, "");

/**
 * @param {string} rel installer path relative to stageDir
 * @returns {{ url: string, signature: string } | null}
 */
function platform(rel) {
  const bin = path.join(stageDir, rel);
  const sig = `${bin}.sig`;
  if (!fs.existsSync(bin) || !fs.existsSync(sig)) return null;
  return {
    url: `${baseUrl}/${rel.replace(/\\/g, "/")}`,
    signature: fs.readFileSync(sig, "utf8").trim(),
  };
}

const platforms = {};

const winNsis = platform(
  `downloads/windows/VidSync-windows-setup-${version}.exe`,
);
const winMsi = platform(
  `downloads/windows/VidSync-windows-${version}.msi`,
);
const linApp = platform(`downloads/linux/VidSync-linux-${version}.AppImage`);
const linDeb = platform(`downloads/linux/VidSync-linux-${version}.deb`);

// Format-specific keys first (plugin prefers `{os}-{arch}-{installer}`)
if (winNsis) {
  platforms["windows-x86_64-nsis"] = winNsis;
  // Default windows-x86_64 → NSIS (matches primary landing download).
  platforms["windows-x86_64"] = winNsis;
}
if (winMsi) {
  platforms["windows-x86_64-msi"] = winMsi;
}
if (linApp) {
  platforms["linux-x86_64-appimage"] = linApp;
  // Legacy / AppImage clients that only look up linux-x86_64
  platforms["linux-x86_64"] = linApp;
}
if (linDeb) {
  platforms["linux-x86_64-deb"] = linDeb;
}

if (Object.keys(platforms).length === 0) {
  console.error(
    "make-updater: no signed platforms found (need versioned installer + .sig)",
  );
  process.exit(1);
}

if (linDeb == null && linApp != null) {
  console.warn(
    "make-updater: no signed .deb — deb installs will fail auto-update with \"invalid updater binary format\"",
  );
}

const updater = {
  version,
  notes: `VidSync ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

const out = path.join(stageDir, "updater.json");
fs.writeFileSync(out, `${JSON.stringify(updater, null, 2)}\n`);
console.log(JSON.stringify(updater, null, 2));
