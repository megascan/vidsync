#!/usr/bin/env node
/**
 * Build Tauri static updater.json from staged installers + .sig files.
 * Usage: node make-updater.mjs <stageDir> <version> [baseUrl]
 *
 * Versioned paths only (avoids Workers Cache serving stale body vs new sig).
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
const win = platform(
  `downloads/windows/VidSync-windows-setup-${version}.exe`,
);
const lin = platform(`downloads/linux/VidSync-linux-${version}.AppImage`);

if (win) platforms["windows-x86_64"] = win;
if (lin) platforms["linux-x86_64"] = lin;

if (Object.keys(platforms).length === 0) {
  console.error(
    "make-updater: no signed platforms found (need versioned installer + .sig)",
  );
  process.exit(1);
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
