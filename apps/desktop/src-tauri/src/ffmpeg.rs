//! Host-side FFmpeg prepare: probe → skip / remux / transcode.
//! Always falls back to the original file so queueing never hard-fails.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{info, warn};

use crate::media_settings::{self, MediaSettings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareProgress {
    pub phase: String,
    pub message: String,
    pub pct: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version_line: Option<String>,
}

#[derive(Debug)]
struct Probe {
    video_codec: Option<String>,
    audio_codec: Option<String>,
    pix_fmt: Option<String>,
    format_name: Option<String>,
    duration_secs: Option<f64>,
    /// subtitle / data / attached pic streams (tmcd etc.)
    extra_streams: u32,
}

pub fn resolve_bin(settings: &MediaSettings, name: &str) -> PathBuf {
    let custom = settings.ffmpeg_path.trim();
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        if p.is_file() {
            if name == "ffprobe" {
                if let Some(parent) = p.parent() {
                    let sib = parent.join(if cfg!(windows) {
                        "ffprobe.exe"
                    } else {
                        "ffprobe"
                    });
                    if sib.is_file() {
                        return sib;
                    }
                }
            }
            if name == "ffmpeg" {
                return p;
            }
        }
        if p.is_dir() {
            let bin = p.join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            });
            if bin.is_file() {
                return bin;
            }
        }
    }
    PathBuf::from(name)
}

pub async fn status(settings: &MediaSettings) -> FfmpegStatus {
    let ff = resolve_bin(settings, "ffmpeg");
    let mut cmd = Command::new(&ff);
    cmd.arg("-version");
    apply_no_window(&mut cmd);
    match cmd.output().await {
        Ok(out) if out.status.success() => {
            let line = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("ffmpeg")
                .to_string();
            FfmpegStatus {
                available: true,
                path: Some(ff.display().to_string()),
                version_line: Some(line),
            }
        }
        _ => FfmpegStatus {
            available: false,
            path: None,
            version_line: None,
        },
    }
}

async fn emit_progress(app: &AppHandle, phase: &str, message: &str, pct: Option<u32>) {
    let _ = app.emit(
        "media-prepare",
        PrepareProgress {
            phase: phase.into(),
            message: message.into(),
            pct,
        },
    );
}

/// Prepare a local file for hosting. **Never fails hard** — falls back to `input`.
pub async fn prepare_for_host(
    app: &AppHandle,
    input: PathBuf,
    settings: &MediaSettings,
) -> Result<PathBuf> {
    match prepare_inner(app, &input, settings).await {
        Ok(p) => Ok(p),
        Err(e) => {
            warn!("media prepare failed ({e:#}) — sharing original");
            emit_progress(
                app,
                "fallback",
                &format!("Prepare failed — sharing original ({e})"),
                None,
            )
            .await;
            Ok(input)
        }
    }
}

async fn prepare_inner(
    app: &AppHandle,
    input: &Path,
    settings: &MediaSettings,
) -> Result<PathBuf> {
    if !settings.enabled || settings.mode_key() == "off" {
        emit_progress(app, "skip", "FFmpeg prepare off", None).await;
        return Ok(input.to_path_buf());
    }

    let st = status(settings).await;
    if !st.available {
        warn!("ffmpeg not found — serving original file");
        emit_progress(
            app,
            "skip",
            "FFmpeg not found — sharing original (install ffmpeg or set path in Settings)",
            None,
        )
        .await;
        return Ok(input.to_path_buf());
    }

    emit_progress(app, "probe", "Probing media…", Some(5)).await;
    let probe = probe_file(settings, input).await?;
    let mode = settings.mode_key();

    let need = match mode {
        "remux" => PrepareKind::Remux,
        "transcode" => PrepareKind::Transcode,
        "auto" => decide_auto(&probe, input),
        _ => PrepareKind::None,
    };

    info!(
        "prepare decision={need:?} v={:?} a={:?} pix={:?} extra={}",
        probe.video_codec, probe.audio_codec, probe.pix_fmt, probe.extra_streams
    );

    match need {
        PrepareKind::None => {
            emit_progress(
                app,
                "skip",
                "Already compatible — no convert needed",
                Some(100),
            )
            .await;
            Ok(input.to_path_buf())
        }
        PrepareKind::Remux => {
            emit_progress(app, "remux", "Remuxing (lossless copy)…", Some(15)).await;
            // Scale timeout with file size (HDD + big MKV) — fixed 180s killed real files.
            let remux_timeout = remux_timeout_for(input);
            let out = run_ffmpeg(
                app,
                settings,
                input,
                &settings.remux_args,
                "remux",
                probe.duration_secs,
                remux_timeout,
            )
            .await?;
            emit_progress(app, "done", "Ready (remux)", Some(100)).await;
            Ok(out)
        }
        PrepareKind::Transcode => {
            emit_progress(app, "transcode", "Transcoding to H.264/AAC…", Some(10)).await;
            let timeout = probe
                .duration_secs
                .map(|d| Duration::from_secs((d * 3.0 + 120.0) as u64))
                .unwrap_or(Duration::from_secs(600))
                .min(Duration::from_secs(3600));
            let out = run_ffmpeg(
                app,
                settings,
                input,
                &settings.transcode_args,
                "x264",
                probe.duration_secs,
                timeout,
            )
            .await?;
            emit_progress(app, "done", "Ready (transcode)", Some(100)).await;
            Ok(out)
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum PrepareKind {
    None,
    Remux,
    Transcode,
}

fn decide_auto(probe: &Probe, path: &Path) -> PrepareKind {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let v = probe.video_codec.as_deref().unwrap_or("");
    let a = probe.audio_codec.as_deref().unwrap_or("");
    let pix = probe.pix_fmt.as_deref().unwrap_or("");
    let fmt = probe.format_name.as_deref().unwrap_or("");

    // Audio-only: leave as-is unless forced remux/transcode mode
    if v.is_empty() && !a.is_empty() {
        return PrepareKind::None;
    }

    let h264 = matches!(v, "h264" | "avc1" | "avc");
    let aac_ok = a.is_empty() || matches!(a, "aac" | "mp4a" | "mp3");
    let pix_ok = pix.is_empty() || pix == "yuv420p";
    let mp4ish = matches!(ext.as_str(), "mp4" | "m4v" | "mov")
        || fmt.contains("mp4")
        || fmt.contains("mov")
        || fmt.contains("ism");

    if v.is_empty() {
        return PrepareKind::None;
    }

    if !h264 || !aac_ok || !pix_ok {
        return PrepareKind::Transcode;
    }

    // H.264 + AAC/MP3 + yuv420p: remux only if container/extra tracks need cleanup
    if mp4ish && probe.extra_streams == 0 {
        PrepareKind::None
    } else {
        PrepareKind::Remux
    }
}

async fn probe_file(settings: &MediaSettings, path: &Path) -> Result<Probe> {
    let ffprobe = resolve_bin(settings, "ffprobe");
    let mut cmd = Command::new(&ffprobe);
    cmd.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(path);
    apply_no_window(&mut cmd);

    let out = cmd
        .output()
        .await
        .with_context(|| format!("run ffprobe {}", ffprobe.display()))?;

    if !out.status.success() {
        bail!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).context("parse ffprobe json")?;

    let mut video_codec = None;
    let mut audio_codec = None;
    let mut pix_fmt = None;
    let mut extra_streams = 0u32;
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let kind = s.get("codec_type").and_then(|x| x.as_str()).unwrap_or("");
            let codec = s
                .get("codec_name")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            match kind {
                "video" if video_codec.is_none() => {
                    // skip attached pics as main video
                    let disp = s
                        .get("disposition")
                        .and_then(|d| d.get("attached_pic"))
                        .and_then(|x| x.as_i64())
                        .unwrap_or(0);
                    if disp == 1 {
                        extra_streams += 1;
                    } else {
                        video_codec = codec;
                        pix_fmt = s
                            .get("pix_fmt")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string());
                    }
                }
                "audio" if audio_codec.is_none() => {
                    audio_codec = codec;
                }
                "video" | "audio" => {}
                _ => {
                    extra_streams += 1;
                }
            }
        }
    }

    let format_name = v
        .pointer("/format/format_name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let duration_secs = v
        .pointer("/format/duration")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok());

    Ok(Probe {
        video_codec,
        audio_codec,
        pix_fmt,
        format_name,
        duration_secs,
        extra_streams,
    })
}

fn cache_out_path(input: &Path, tag: &str) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    input.to_string_lossy().hash(&mut h);
    if let Ok(meta) = std::fs::metadata(input) {
        meta.len().hash(&mut h);
        if let Ok(m) = meta.modified() {
            if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
                d.as_nanos().hash(&mut h);
            }
        }
    }
    tag.hash(&mut h);
    let name = format!("{:x}_{tag}.mp4", h.finish());
    media_settings::cache_dir().join(name)
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

fn remux_timeout_for(input: &Path) -> Duration {
    let size = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
    // ~3 min base + 1 min per 5GB, cap 45 min
    let extra = (size / (5 * 1024 * 1024 * 1024)).saturating_mul(60);
    Duration::from_secs((180 + extra).min(45 * 60).max(180))
}

async fn run_ffmpeg(
    app: &AppHandle,
    settings: &MediaSettings,
    input: &Path,
    args_line: &str,
    tag: &str,
    duration_secs: Option<f64>,
    timeout: Duration,
) -> Result<PathBuf> {
    let out = cache_out_path(input, tag);
    if out.is_file() {
        info!("ffmpeg cache hit {}", out.display());
        emit_progress(app, "cache", "Using cached convert", Some(100)).await;
        return Ok(out);
    }

    // Write to .part then rename — crash mid-transcode must not poison cache.
    let part = {
        let mut p = out.as_os_str().to_owned();
        p.push(".part");
        PathBuf::from(p)
    };
    let _ = std::fs::remove_file(&part);

    let ffmpeg = resolve_bin(settings, "ffmpeg");
    // -progress pipe:1 → newline key=value on stdout (reliable %).
    // Default stderr stats use \r and line readers almost never see time=.
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-stats_period".into(),
        "0.25".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-i".into(),
        input.display().to_string(),
    ];
    for tok in shell_split(args_line) {
        args.push(tok);
    }
    args.push(part.display().to_string());

    info!("ffmpeg {} {:?}", ffmpeg.display(), args);
    let kind = if tag.contains("x264") || tag == "transcode" {
        "Transcoding"
    } else {
        "Remuxing"
    };
    emit_progress(app, "ffmpeg", &format!("{kind}…"), Some(2)).await;

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn ffmpeg {}", ffmpeg.display()))?;

    // Drain stderr so the pipe never blocks ffmpeg
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
    }

    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let mut lines = BufReader::new(stdout).lines();
    let app_progress = app.clone();
    let dur = duration_secs;

    let wait_fut = async {
        let mut last_pct: u32 = 2;
        let mut last_emit = std::time::Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(std::time::Instant::now);
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(pct) = parse_progress_line(&line, dur) {
                // Throttle UI spam; always allow 100/end
                let now = std::time::Instant::now();
                if pct >= 99
                    || pct > last_pct
                        && now.duration_since(last_emit) >= Duration::from_millis(200)
                {
                    last_pct = pct.max(last_pct);
                    last_emit = now;
                    let msg = format!("{kind}… {last_pct}%");
                    emit_progress(&app_progress, "progress", &msg, Some(last_pct)).await;
                }
            } else if line.trim() == "progress=end" {
                emit_progress(&app_progress, "progress", &format!("{kind}… 100%"), Some(100))
                    .await;
            }
        }
        child.wait().await.context("wait ffmpeg")
    };

    let status = match tokio::time::timeout(timeout, wait_fut).await {
        Ok(r) => r?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&part);
            bail!("ffmpeg timed out after {timeout:?}");
        }
    };

    if !status.success() {
        let _ = std::fs::remove_file(&part);
        bail!("ffmpeg exited with {status}");
    }
    if !part.is_file() {
        bail!("ffmpeg produced no output");
    }
    // Atomic-ish publish into cache path
    let _ = std::fs::remove_file(&out);
    std::fs::rename(&part, &out).with_context(|| {
        format!(
            "rename {} → {}",
            part.display(),
            out.display()
        )
    })?;
    media_settings::prune_cache(10 * 1024 * 1024 * 1024); // 10 GiB cap
    emit_progress(app, "done", "Ready", Some(100)).await;
    Ok(out)
}

/// Parse `-progress pipe:1` key=value lines into 0–99 (100 reserved for done).
fn parse_progress_line(line: &str, duration_secs: Option<f64>) -> Option<u32> {
    let line = line.trim();
    let dur = duration_secs.filter(|d| *d > 0.5)?;

    // Prefer out_time_ms (microseconds despite the name) / out_time_us
    if let Some(rest) = line.strip_prefix("out_time_ms=") {
        let us: f64 = rest.trim().parse().ok()?;
        if us < 0.0 {
            return None;
        }
        let t = us / 1_000_000.0;
        return Some(((t / dur) * 100.0).clamp(0.0, 99.0) as u32);
    }
    if let Some(rest) = line.strip_prefix("out_time_us=") {
        let us: f64 = rest.trim().parse().ok()?;
        if us < 0.0 {
            return None;
        }
        let t = us / 1_000_000.0;
        return Some(((t / dur) * 100.0).clamp(0.0, 99.0) as u32);
    }
    if let Some(rest) = line.strip_prefix("out_time=") {
        // HH:MM:SS.microseconds
        let token = rest.trim();
        let parts: Vec<_> = token.split(':').collect();
        if parts.len() != 3 {
            return None;
        }
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let s: f64 = parts[2].parse().ok()?;
        let t = h * 3600.0 + m * 60.0 + s;
        return Some(((t / dur) * 100.0).clamp(0.0, 99.0) as u32);
    }
    None
}

fn shell_split(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    for c in s.chars() {
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            c if c.is_whitespace() && !in_single && !in_double => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}
