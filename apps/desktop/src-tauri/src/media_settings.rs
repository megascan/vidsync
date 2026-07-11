//! Host media / FFmpeg settings (persisted under app config dir).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Quality-preserving remux: copy streams, strip subtitles/data, faststart for streaming.
pub const DEFAULT_REMUX_ARGS: &str =
    "-map 0:v:0 -map 0:a:0? -c copy -movflags +faststart -sn -dn";

/// Widely compatible high-quality re-encode (H.264 yuv420p + AAC). CRF 18 ≈ transparent.
pub const DEFAULT_TRANSCODE_ARGS: &str = concat!(
    "-map 0:v:0 -map 0:a:0? ",
    "-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -profile:v high -level 4.1 ",
    "-c:a aac -b:a 192k -ac 2 -ar 48000 ",
    "-movflags +faststart -sn -dn"
);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSettings {
    /// Run FFmpeg prepare step when opening local files (host only).
    pub enabled: bool,
    /// Empty = search PATH for `ffmpeg` / `ffprobe`.
    pub ffmpeg_path: String,
    /// auto | off | remux | transcode
    pub mode: String,
    pub remux_args: String,
    pub transcode_args: String,
}

impl Default for MediaSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ffmpeg_path: String::new(),
            mode: "auto".into(),
            remux_args: DEFAULT_REMUX_ARGS.into(),
            transcode_args: DEFAULT_TRANSCODE_ARGS.into(),
        }
    }
}

impl MediaSettings {
    pub fn mode_key(&self) -> &str {
        match self.mode.as_str() {
            "off" | "remux" | "transcode" | "auto" => self.mode.as_str(),
            _ => "auto",
        }
    }
}

pub fn settings_path() -> PathBuf {
    dirs_config().join("media-settings.json")
}

fn dirs_config() -> PathBuf {
    if let Some(base) = dirs_next_config() {
        let p = base.join("vidsync");
        let _ = fs::create_dir_all(&p);
        p
    } else {
        let p = std::env::temp_dir().join("vidsync");
        let _ = fs::create_dir_all(&p);
        p
    }
}

fn dirs_next_config() -> Option<PathBuf> {
    // Avoid extra crate: platform config dir
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }
}

pub fn load() -> MediaSettings {
    let path = settings_path();
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => MediaSettings::default(),
    }
}

pub fn save(settings: &MediaSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| e.to_string())
}

pub fn cache_dir() -> PathBuf {
    let p = dirs_config().join("media-cache");
    let _ = fs::create_dir_all(&p);
    p
}

/// Drop oldest cache files until total size ≤ `max_bytes`. Ignores errors.
pub fn prune_cache(max_bytes: u64) {
    let dir = cache_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for e in rd.flatten() {
        let path = e.path();
        if !path.is_file() {
            continue;
        }
        // Never keep partial outputs
        if path.extension().and_then(|x| x.to_str()) == Some("part")
            || path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(".part"))
                .unwrap_or(false)
        {
            let _ = fs::remove_file(&path);
            continue;
        }
        let Ok(meta) = e.metadata() else {
            continue;
        };
        let len = meta.len();
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        total = total.saturating_add(len);
        files.push((path, len, modified));
    }
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(_, _, m)| *m); // oldest first
    for (path, len, _) in files {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}
