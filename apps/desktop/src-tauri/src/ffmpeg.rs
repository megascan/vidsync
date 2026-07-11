//! Host-side FFmpeg prepare: probe → remux (copy) or high-quality transcode.

use std::path::{Path, PathBuf};
use std::process::Stdio;

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
}

pub fn resolve_bin(settings: &MediaSettings, name: &str) -> PathBuf {
    let custom = settings.ffmpeg_path.trim();
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        if p.is_file() {
            // If user pointed at ffmpeg.exe, ffprobe is sibling
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
        // directory?
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
    match Command::new(&ff).arg("-version").output().await {
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

/// Prepare a local file for hosting. Returns path to serve (original or cache).
pub async fn prepare_for_host(
    app: &AppHandle,
    input: PathBuf,
    settings: &MediaSettings,
) -> Result<PathBuf> {
    if !settings.enabled || settings.mode_key() == "off" {
        return Ok(input);
    }

    let st = status(settings).await;
    if !st.available {
        warn!("ffmpeg not found — serving original file");
        emit_progress(
            app,
            "skip",
            "FFmpeg not found — serving original file",
            None,
        )
        .await;
        return Ok(input);
    }

    emit_progress(app, "probe", "Probing media…", Some(5)).await;
    let probe = probe_file(settings, &input).await?;
    let mode = settings.mode_key();

    let need = match mode {
        "remux" => PrepareKind::Remux,
        "transcode" => PrepareKind::Transcode,
        "auto" => decide_auto(&probe, &input),
        _ => PrepareKind::None,
    };

    match need {
        PrepareKind::None => {
            emit_progress(app, "skip", "Already compatible — no convert", Some(100)).await;
            Ok(input)
        }
        PrepareKind::Remux => {
            emit_progress(app, "remux", "Remuxing (lossless copy)…", Some(15)).await;
            let out = run_ffmpeg(app, settings, &input, &settings.remux_args, "remux", probe.duration_secs)
                .await?;
            emit_progress(app, "done", "Ready (remux)", Some(100)).await;
            Ok(out)
        }
        PrepareKind::Transcode => {
            emit_progress(app, "transcode", "Transcoding to H.264/AAC…", Some(10)).await;
            let out = run_ffmpeg(
                app,
                settings,
                &input,
                &settings.transcode_args,
                "x264",
                probe.duration_secs,
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

    let h264 = matches!(v, "h264" | "avc1" | "avc");
    let aac_ok = a.is_empty() || matches!(a, "aac" | "mp4a");
    let pix_ok = pix.is_empty() || pix == "yuv420p";
    let mp4ish = matches!(ext.as_str(), "mp4" | "m4v" | "mov")
        || fmt.contains("mp4")
        || fmt.contains("mov")
        || fmt.contains("ism");

    if h264 && aac_ok && pix_ok && mp4ish {
        // Clean enough — still remux to strip tmcd/data + faststart when container messy
        // Prefer remux for safety (cheap)
        PrepareKind::Remux
    } else if h264 && aac_ok {
        // Right codecs, wrong container or extra tracks
        PrepareKind::Remux
    } else if v.is_empty() {
        PrepareKind::None
    } else {
        PrepareKind::Transcode
    }
}

async fn probe_file(settings: &MediaSettings, path: &Path) -> Result<Probe> {
    let ffprobe = resolve_bin(settings, "ffprobe");
    let out = Command::new(&ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
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
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let kind = s.get("codec_type").and_then(|x| x.as_str()).unwrap_or("");
            let codec = s
                .get("codec_name")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            if kind == "video" && video_codec.is_none() {
                video_codec = codec;
                pix_fmt = s
                    .get("pix_fmt")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
            } else if kind == "audio" && audio_codec.is_none() {
                audio_codec = codec;
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

async fn run_ffmpeg(
    app: &AppHandle,
    settings: &MediaSettings,
    input: &Path,
    args_line: &str,
    tag: &str,
    duration_secs: Option<f64>,
) -> Result<PathBuf> {
    let out = cache_out_path(input, tag);
    if out.is_file() {
        info!("ffmpeg cache hit {}", out.display());
        emit_progress(app, "cache", "Using cached convert", Some(100)).await;
        return Ok(out);
    }

    let ffmpeg = resolve_bin(settings, "ffmpeg");
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-i".into(),
        input.display().to_string(),
    ];
    for tok in shell_split(args_line) {
        args.push(tok);
    }
    args.push(out.display().to_string());

    info!("ffmpeg {} {:?}", ffmpeg.display(), args);

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn ffmpeg {}", ffmpeg.display()))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("no stderr"))?;
    let mut lines = BufReader::new(stderr).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(pct) = parse_ffmpeg_pct(&line, duration_secs) {
            emit_progress(app, "progress", &line, Some(pct)).await;
        }
    }

    let status = child.wait().await.context("wait ffmpeg")?;
    if !status.success() {
        let _ = std::fs::remove_file(&out);
        bail!("ffmpeg exited with {status}");
    }
    if !out.is_file() {
        bail!("ffmpeg produced no output");
    }
    Ok(out)
}

fn parse_ffmpeg_pct(line: &str, duration_secs: Option<f64>) -> Option<u32> {
    // time=00:01:23.45
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let token = rest.split_whitespace().next()?;
    let parts: Vec<_> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    let t = h * 3600.0 + m * 60.0 + s;
    let dur = duration_secs.filter(|d| *d > 0.5)?;
    let pct = ((t / dur) * 100.0).clamp(0.0, 99.0) as u32;
    Some(pct)
}

/// Minimal argv split (handles simple quotes).
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
