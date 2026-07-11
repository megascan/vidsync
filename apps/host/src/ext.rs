//! Install / stage VidSync Unblock extension for Chromium browsers.
//!
//! Chrome cannot silently install unpacked MV3 extensions for normal users.
//! We:
//! 1. Copy extension into a stable user data dir
//! 2. Optionally launch Chrome/Edge with --load-extension for this session
//! 3. Open extensions page and print Load unpacked steps

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

const EXT_NAME: &str = "vidsync-unblock";

pub fn install(from: Option<PathBuf>, launch: bool, prefer_edge: bool) -> Result<String> {
    let src = resolve_source(from)?;
    let dest = install_dir()?;
    if dest.exists() {
        fs::remove_dir_all(&dest).with_context(|| format!("clear {}", dest.display()))?;
    }
    recursive_copy(&src, &dest)?;
    ensure_manifest(&dest)?;

    let mut out = String::new();
    out.push_str(&format!(
        "Unblock extension staged at:\n  {}\n",
        dest.display()
    ));

    let browser = if prefer_edge {
        find_edge().or_else(find_chrome)
    } else {
        find_chrome().or_else(find_edge)
    };

    if launch {
        if let Some(bin) = browser {
            let status = Command::new(&bin)
                .arg(format!("--load-extension={}", dest.display()))
                .arg("https://vidsync.ratt.ing/")
                .spawn();
            match status {
                Ok(_) => {
                    out.push_str(&format!(
                        "\nLaunched {} with --load-extension (this browser session).\n\
                         Permanent install:\n\
                         1. Open chrome://extensions (or edge://extensions)\n\
                         2. Enable Developer mode\n\
                         3. Load unpacked → select:\n   {}\n",
                        bin.display(),
                        dest.display()
                    ));
                }
                Err(e) => {
                    out.push_str(&format!(
                        "\nCould not launch browser ({e}). Manual steps below.\n"
                    ));
                    out.push_str(&manual_steps(&dest));
                }
            }
        } else {
            out.push_str("\nChrome/Edge not found.\n");
            out.push_str(&manual_steps(&dest));
        }
    } else {
        out.push_str(&manual_steps(&dest));
    }

    if launch {
        // Best-effort; chrome:// may no-op depending on OS handler
        let _ = open::that(if prefer_edge {
            "edge://extensions"
        } else {
            "chrome://extensions"
        });
    }

    Ok(out)
}

fn manual_steps(dest: &Path) -> String {
    format!(
        "\nPermanent install (unpacked):\n\
         1. chrome://extensions or edge://extensions\n\
         2. Developer mode ON\n\
         3. Load unpacked →\n   {}\n",
        dest.display()
    )
}

fn install_dir() -> Result<PathBuf> {
    let base = dirs_data_local()?;
    Ok(base.join("VidSync").join("extension").join(EXT_NAME))
}

fn dirs_data_local() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        return Ok(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("XDG_DATA_HOME") {
        return Ok(PathBuf::from(p));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home).join(".local").join("share"));
    }
    bail!("cannot resolve local data dir");
}

fn resolve_source(from: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = from {
        let p = p.canonicalize().context("from path")?;
        ensure_manifest(&p)?;
        return Ok(p);
    }
    if let Ok(env) = std::env::var("VIDSYNC_EXTENSION_DIR") {
        let p = PathBuf::from(env).canonicalize()?;
        ensure_manifest(&p)?;
        return Ok(p);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("extension").join(EXT_NAME),
                dir.join(EXT_NAME),
                dir.join("extensions").join(EXT_NAME),
            ] {
                if cand.join("manifest.json").is_file() {
                    return Ok(cand.canonicalize()?);
                }
            }
        }
    }

    let cwd = std::env::current_dir()?;
    for cand in [
        cwd.join("extensions").join(EXT_NAME),
        cwd.join("..").join("..").join("extensions").join(EXT_NAME),
        cwd.join("..").join("extensions").join(EXT_NAME),
    ] {
        if cand.join("manifest.json").is_file() {
            return Ok(cand.canonicalize()?);
        }
    }

    bail!(
        "could not find {EXT_NAME}. Pass --from PATH or set VIDSYNC_EXTENSION_DIR.\n\
         Expected monorepo path: extensions/vidsync-unblock"
    );
}

fn ensure_manifest(dir: &Path) -> Result<()> {
    if !dir.join("manifest.json").is_file() {
        bail!("no manifest.json in {}", dir.display());
    }
    Ok(())
}

fn recursive_copy(src: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            recursive_copy(&from, &to)?;
        } else {
            fs::copy(&from, &to)
                .with_context(|| format!("copy {} → {}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

fn find_chrome() -> Option<PathBuf> {
    candidates_windows_chrome()
        .into_iter()
        .chain(which("chrome"))
        .chain(which("google-chrome"))
        .chain(which("chromium"))
        .find(|p| p.is_file())
}

fn find_edge() -> Option<PathBuf> {
    candidates_windows_edge()
        .into_iter()
        .chain(which("msedge"))
        .chain(which("microsoft-edge"))
        .find(|p| p.is_file())
}

fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
        let p_exe = dir.join(format!("{name}.exe"));
        if p_exe.is_file() {
            return Some(p_exe);
        }
    }
    None
}

fn candidates_windows_chrome() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        v.push(
            PathBuf::from(local)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe"),
        );
    }
    if let Ok(pf) = std::env::var("PROGRAMFILES") {
        v.push(
            PathBuf::from(pf)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe"),
        );
    }
    if let Ok(pf) = std::env::var("PROGRAMFILES(X86)") {
        v.push(
            PathBuf::from(pf)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe"),
        );
    }
    v
}

fn candidates_windows_edge() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(pf) = std::env::var("PROGRAMFILES(X86)") {
        v.push(
            PathBuf::from(pf)
                .join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe"),
        );
    }
    if let Ok(pf) = std::env::var("PROGRAMFILES") {
        v.push(
            PathBuf::from(pf)
                .join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe"),
        );
    }
    v
}
