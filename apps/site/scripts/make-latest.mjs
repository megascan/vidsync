#!/usr/bin/env node
/**
 * Build latest.json from staged download files.
 * Usage: node make-latest.mjs <stageDir> <version> <commit>
 *
 * Expects versioned names:
 *   downloads/windows/VidSync-windows-setup-{version}.exe
 *   downloads/linux/VidSync-linux-{version}.AppImage
 */
import fs from "node:fs";
import path from "node:path";

const [stageDir, version, commit] = process.argv.slice(2);
if (!stageDir || !version || !commit) {
  console.error("usage: make-latest.mjs <stageDir> <version> <commit>");
  process.exit(1);
}

function file(rel) {
  const p = path.join(stageDir, rel);
  if (!fs.existsSync(p)) return null;
  return {
    path: `/${rel.replace(/\\/g, "/")}`,
    size: fs.statSync(p).size,
  };
}

const winNsis = file(`downloads/windows/VidSync-windows-setup-${version}.exe`);
const winMsi = file(`downloads/windows/VidSync-windows-${version}.msi`);
const linApp = file(`downloads/linux/VidSync-linux-${version}.AppImage`);
const linDeb = file(`downloads/linux/VidSync-linux-${version}.deb`);

const latest = {
  version,
  commit,
  publishedAt: new Date().toISOString(),
  windows: winNsis
    ? {
        nsis: winNsis.path,
        nsisSize: winNsis.size,
        ...(winMsi ? { msi: winMsi.path, msiSize: winMsi.size } : {}),
      }
    : null,
  linux: linApp || linDeb
    ? {
        ...(linApp
          ? { appimage: linApp.path, appimageSize: linApp.size }
          : {}),
        ...(linDeb ? { deb: linDeb.path, debSize: linDeb.size } : {}),
      }
    : null,
};

const out = path.join(stageDir, "latest.json");
fs.writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`);
console.log(JSON.stringify(latest, null, 2));
