//! mpv external player via JSON IPC (named pipe / unix socket).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tracing::{info, warn};

pub struct MpvPlayer {
    child: Child,
    ipc_path: String,
    stream: Mutex<Option<std::fs::File>>,
    applying: Arc<AtomicBool>,
}

impl MpvPlayer {
    pub fn start() -> Result<Self> {
        let mpv = find_mpv().ok_or_else(|| {
            anyhow!(
                "mpv not found. Install mpv and ensure it is on PATH \
                 (https://mpv.io) or place mpv.exe next to this binary."
            )
        })?;

        let ipc_path = ipc_path_for_process();
        // Remove stale pipe/socket path if any
        let _ = std::fs::remove_file(&ipc_path);

        let mut cmd = Command::new(&mpv);
        cmd.arg("--idle=yes")
            .arg("--force-window=yes")
            .arg("--keep-open=yes")
            .arg("--osc=yes")
            .arg(format!("--input-ipc-server={ipc_path}"))
            .arg("--title=VidSync Player")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().with_context(|| format!("spawn {}", mpv.display()))?;
        info!("mpv started pid={} ipc={ipc_path}", child.id());

        let player = Self {
            child,
            ipc_path,
            stream: Mutex::new(None),
            applying: Arc::new(AtomicBool::new(false)),
        };

        // Wait for IPC to accept connections
        for _ in 0..40 {
            thread::sleep(Duration::from_millis(100));
            if player.ensure_ipc().is_ok() {
                let _ = player.command(&["get_property", "mpv-version"]);
                return Ok(player);
            }
        }
        bail!("mpv IPC not ready at {}", player.ipc_path);
    }

    fn ensure_ipc(&self) -> Result<()> {
        let mut g = self.stream.lock().unwrap();
        if g.is_some() {
            return Ok(());
        }
        let f = open_ipc(&self.ipc_path)?;
        *g = Some(f);
        Ok(())
    }

    pub fn command(&self, args: &[&str]) -> Result<serde_json::Value> {
        self.ensure_ipc()?;
        let mut g = self.stream.lock().unwrap();
        let f = g.as_mut().ok_or_else(|| anyhow!("no ipc"))?;

        let payload = serde_json::json!({ "command": args });
        let line = format!("{payload}\n");
        f.write_all(line.as_bytes()).context("ipc write")?;
        f.flush().ok();

        let mut reader = BufReader::new(f.try_clone().context("ipc clone")?);
        // Read until we get a line with "error" or "data" (skip events)
        for _ in 0..20 {
            let mut buf = String::new();
            reader.read_line(&mut buf).context("ipc read")?;
            if buf.trim().is_empty() {
                continue;
            }
            let v: serde_json::Value = serde_json::from_str(buf.trim()).context("ipc json")?;
            if v.get("event").is_some() {
                continue;
            }
            return Ok(v);
        }
        bail!("no ipc reply")
    }

    pub fn load_url(&self, url: &str) -> Result<()> {
        self.applying.store(true, Ordering::SeqCst);
        let r = self.command(&["loadfile", url, "replace"]);
        self.applying.store(false, Ordering::SeqCst);
        r.map(|_| ())
    }

    pub fn set_pause(&self, pause: bool) -> Result<()> {
        self.applying.store(true, Ordering::SeqCst);
        let r = self.command(&["set_property", "pause", if pause { "yes" } else { "no" }]);
        self.applying.store(false, Ordering::SeqCst);
        r.map(|_| ())
    }

    pub fn seek_seconds(&self, sec: f64) -> Result<()> {
        self.applying.store(true, Ordering::SeqCst);
        let s = format!("{sec:.3}");
        let r = self.command(&["seek", &s, "absolute"]);
        self.applying.store(false, Ordering::SeqCst);
        r.map(|_| ())
    }

    pub fn time_pos_ms(&self) -> Result<f64> {
        let v = self.command(&["get_property", "time-pos"])?;
        let data = v.get("data").and_then(|d| d.as_f64()).unwrap_or(0.0);
        Ok(data * 1000.0)
    }

    pub fn is_paused(&self) -> Result<bool> {
        let v = self.command(&["get_property", "pause"])?;
        Ok(v.get("data").and_then(|d| d.as_bool()).unwrap_or(true))
    }

    pub fn applying_remote(&self) -> bool {
        self.applying.load(Ordering::SeqCst)
    }

    /// Apply room state (follower or resync).
    pub fn apply_state(&self, url: Option<&str>, is_playing: bool, position_ms: f64) -> Result<()> {
        if let Some(u) = url {
            // Always reload if different — mpv path; cheap enough for MVP when version changes
            let _ = self.load_url(u);
        }
        let sec = (position_ms / 1000.0).max(0.0);
        let _ = self.seek_seconds(sec);
        self.set_pause(!is_playing)?;
        Ok(())
    }
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        let _ = self.command(&["quit"]);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.ipc_path);
    }
}

fn find_mpv() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["mpv.exe", "mpv"] {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    which("mpv").or_else(|| which("mpv.exe"))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn ipc_path_for_process() -> String {
    let n = std::process::id();
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\vidsync-mpv-{n}")
    }
    #[cfg(not(windows))]
    {
        format!("/tmp/vidsync-mpv-{n}.sock")
    }
}

fn open_ipc(path: &str) -> Result<std::fs::File> {
    #[cfg(windows)]
    {
        // Named pipes: open for read/write
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .with_context(|| format!("open pipe {path}"))
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::net::UnixStream;
        let stream = UnixStream::connect(path).with_context(|| format!("connect {path}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
        // Convert via file descriptor — UnixStream into File
        use std::os::unix::io::{FromRawFd, IntoRawFd};
        let fd = stream.into_raw_fd();
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }
}

pub fn mpv_available() -> bool {
    find_mpv().is_some()
}
