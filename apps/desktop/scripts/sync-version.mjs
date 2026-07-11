#!/usr/bin/env node
/**
 * Keep desktop version in sync across package.json / Cargo.toml / tauri.conf.json.
 *
 *   node scripts/sync-version.mjs                 # print current
 *   node scripts/sync-version.mjs --set 0.2.0     # set exact
 *   node scripts/sync-version.mjs --ci            # CI: monotonic patch from GITHUB_RUN_NUMBER
 *
 * --ci formula: max(package.patch + 1, GITHUB_RUN_NUMBER) so every release is
 * strictly newer than the last committed version even without committing bumps.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const pkgPath = path.join(root, "package.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");

function readPkgVersion() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return String(pkg.version);
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) throw new Error(`invalid semver: ${v}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function format({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function writeAll(version) {
  parseSemver(version); // validate

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  let cargo = fs.readFileSync(cargoPath, "utf8");
  cargo = cargo.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${version}"`,
  );
  fs.writeFileSync(cargoPath, cargo);

  const tauri = JSON.parse(fs.readFileSync(tauriPath, "utf8"));
  tauri.version = version;
  fs.writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

  console.log(`synced desktop version → ${version}`);
  console.log(`  package.json`);
  console.log(`  src-tauri/Cargo.toml`);
  console.log(`  src-tauri/tauri.conf.json`);
}

const args = process.argv.slice(2);

if (args.includes("--ci")) {
  const cur = parseSemver(readPkgVersion());
  const run = Number(process.env.GITHUB_RUN_NUMBER || "0");
  if (!Number.isFinite(run) || run < 1) {
    console.error("--ci needs GITHUB_RUN_NUMBER");
    process.exit(1);
  }
  // Always strictly greater than committed package version; tracks CI run.
  // Fold run_attempt so a re-run of a green job cannot republish same version
  // with different bytes under an immutable R2 key.
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT || "1");
  const attemptSuffix =
    Number.isFinite(attempt) && attempt > 1 ? attempt - 1 : 0;
  const patch = Math.max(cur.patch + 1, run) + attemptSuffix * 1000;
  const next = format({ major: cur.major, minor: cur.minor, patch });
  writeAll(next);
  // Expose for later workflow steps
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `version=${next}\n`);
  }
  process.exit(0);
}

const setIdx = args.indexOf("--set");
if (setIdx >= 0) {
  const v = args[setIdx + 1];
  if (!v) {
    console.error("usage: --set X.Y.Z");
    process.exit(1);
  }
  writeAll(v);
  process.exit(0);
}

console.log(readPkgVersion());
