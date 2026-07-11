import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./styles.css";

type Member = {
  sessionId: string;
  nickname: string;
  isHost: boolean;
  platform?: "windows" | "linux" | "macos" | "web" | "unknown" | string;
  /** RTT to room DO (ms), when measured. */
  rttMs?: number;
};

type MediaSettings = {
  enabled: boolean;
  ffmpegPath: string;
  mode: string;
  remuxArgs: string;
  transcodeArgs: string;
};

type FfmpegStatus = {
  available: boolean;
  path: string | null;
  versionLine: string | null;
};

type PlaybackState = {
  version: number;
  videoUrl: string | null;
  isPlaying: boolean;
  positionMs: number;
  serverAnchorMs: number;
  hostSessionId: string | null;
  updatedAtMs: number;
  queue: string[];
  queueIndex: number | null;
};

type ServeInfo = {
  lanUrl: string;
  publicUrl: string | null;
  upnpMapped: boolean;
  publicIp: string | null;
  localPort: number;
  fileName: string;
};

type SyncEvent =
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number; reason: string }
  | { kind: "disconnected"; reason: string }
  | {
      kind: "welcome";
      session_id: string;
      is_host: boolean;
      state: PlaybackState;
      members: Member[];
      server_time_ms: number;
    }
  | { kind: "state"; state: PlaybackState; server_time_ms: number }
  | { kind: "members"; members: Member[] }
  | {
      kind: "chat";
      message: {
        id: string;
        sessionId: string;
        nickname: string;
        text: string;
        serverTimeMs: number;
      };
    }
  | { kind: "latency"; rtt_ms: number; server_time_ms: number }
  | { kind: "error"; code: string; message: string }
  | { kind: "room_closed"; reason: string; message: string };

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (k in obj) return obj[k] as T;
  }
  return undefined;
}

/** Coerce server/Rust member shapes; drop exact sessionId dupes. */
function normalizeMembers(raw: unknown): Member[] {
  if (!Array.isArray(raw)) return [];
  const out: Member[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const sessionId = String(
      pick(o, "sessionId", "session_id") ?? "",
    ).trim();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const platform = pick<string>(o, "platform");
    const rttRaw = pick<unknown>(o, "rttMs", "rtt_ms");
    const rttMs =
      typeof rttRaw === "number" && Number.isFinite(rttRaw)
        ? Math.round(rttRaw)
        : typeof rttRaw === "string" && rttRaw.trim()
          ? Math.round(Number(rttRaw))
          : undefined;
    out.push({
      sessionId,
      nickname: String(pick(o, "nickname") ?? "viewer"),
      isHost: Boolean(pick(o, "isHost", "is_host")),
      ...(platform ? { platform } : {}),
      ...(rttMs != null && Number.isFinite(rttMs) && rttMs >= 0
        ? { rttMs }
        : {}),
    });
  }
  return out;
}

function formatPing(rttMs: number | undefined): string {
  if (rttMs == null || !Number.isFinite(rttMs) || rttMs < 0) return "—";
  if (rttMs < 1000) return `${Math.round(rttMs)}ms`;
  return `${(rttMs / 1000).toFixed(1)}s`;
}

function pingClass(rttMs: number | undefined): string {
  if (rttMs == null || !Number.isFinite(rttMs)) return "ping faint";
  if (rttMs < 80) return "ping good";
  if (rttMs < 180) return "ping ok";
  return "ping bad";
}

function peopleListHtml(list: Member[]): string {
  return (
    list
      .map((m) => {
        const you = m.sessionId === sessionId;
        // Prefer live local sample for "you"
        const rtt = you && myRttMs > 0 ? myRttMs : m.rttMs;
        return `<li>
          ${platformBadge(m.platform)}
          <span class="${you ? "you" : ""}">${escapeHtml(m.nickname)}${you ? " (you)" : ""}</span>
          ${m.isHost ? `<span class="tag">host</span>` : ""}
          <span class="${pingClass(rtt)}" title="RTT to room server">${escapeHtml(formatPing(rtt))}</span>
        </li>`;
      })
      .join("") || `<li class="empty">…</li>`
  );
}

const app = document.querySelector<HTMLDivElement>("#app")!;

const DEFAULT_API = "https://api.vidsync.ratt.ing";
const STREAM_PORT = 8765;
/** Always on — no UI toggle. */
const USE_UPNP = true;

let apiBase = DEFAULT_API;
let nick = localStorage.getItem("vidsync.nick") || "";
let roomCode = "";
let isHost = false;
let sessionId = "";
let members: Member[] = [];
let playback: PlaybackState | null = null;
let chat: { nick: string; text: string }[] = [];
let status = "";
let error = "";
let streamInfo: ServeInfo | null = null;
let screen: "home" | "room" | "settings" = "home";
/** Where Settings “Back” returns. */
let settingsReturn: "home" | "room" = "home";
let joinCode = "";
let busy = false;
let mediaSettings: MediaSettings | null = null;
let ffmpegInfo: FfmpegStatus | null = null;
let prepareStatus = "";
/** Avoid full DOM rebuild while video is playing (reparent = flicker). */
let roomShellReady = false;
/** Follower: waiting for HTTP buffer before chasing host (remote peers). */
let followerBuffering = false;
/** Seconds of media we want buffered ahead before playing. */
const FOLLOWER_MIN_BUFFER_SEC = 4;
/** Only hard-seek if farther than this from host timeline. */
const FOLLOWER_HARD_DRIFT_SEC = 4;
/** Soft catch-up rate tweak band. */
const FOLLOWER_SOFT_DRIFT_SEC = 1.5;
let clockOffsetMs = 0;
/** Local RTT to room DO (ms), EMA-smoothed from latency events. */
let myRttMs = 0;
let applyingRemote = false;
let lastVersion = -1;
let chatDraft = "";
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumps when a newer applyState supersedes an in-flight one (join races). */
let applyGen = 0;

/** In-app auto-update (Tauri signed releases). */
type UpdateUi =
  | { phase: "idle" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; pct: number | null }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

let updateUi: UpdateUi = { phase: "idle" };
let pendingUpdate: Update | null = null;
let updateBusy = false;
/** Installed app version (from Tauri), shown on home + used to filter false updates. */
let appVersion = "";

const video = document.createElement("video");
video.playsInline = true;
video.controls = true;
video.preload = "auto";
video.setAttribute("controlsList", "nodownload");
// Do NOT set crossOrigin — WebKitGTK + ranged HTTP streams often fail silently
// with CORS mode "anonymous" even when ACAO:* is present.

function nowServer(): number {
  return Date.now() + clockOffsetMs;
}

/** Host one-way lag ≈ host RTT/2 (packet in flight while media advanced). */
function hostOneWayMs(): number {
  const host = members.find((m) => m.isHost);
  const rtt =
    host && host.sessionId === sessionId && myRttMs > 0
      ? myRttMs
      : (host?.rttMs ?? 0);
  if (!Number.isFinite(rtt) || rtt <= 0) return 0;
  return rtt / 2;
}

/**
 * Target media position on the host timeline.
 * + hostOneWay: host position was sampled before the DO stamped the anchor.
 */
function expectedPos(state: PlaybackState): number {
  if (!state.isPlaying) return state.positionMs;
  return Math.max(
    0,
    state.positionMs + (nowServer() - state.serverAnchorMs) + hostOneWayMs(),
  );
}

function setStatus(s: string) {
  status = s;
  error = "";
  paint();
}

function setError(e: string) {
  error = e.replace(/^Error:\s*/i, "");
  paint();
}

function toast(s: string) {
  status = s;
  error = "";
  const el = app.querySelector("[data-flash]");
  if (el) {
    el.className = "flash ok";
    el.textContent = s;
  } else {
    paint();
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (status === s) {
      status = "";
      const f = app.querySelector("[data-flash]");
      if (f) f.textContent = "";
    }
  }, 2200);
}

function applyClock(serverTimeMs: number, rttMs?: number) {
  // Cristian-style: server time at arrival ≈ serverTimeMs + one-way
  const oneWay =
    rttMs != null && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs / 2 : 0;
  clockOffsetMs = serverTimeMs + oneWay - Date.now();
}

function applyLatency(rttMs: number, serverTimeMs: number) {
  const rtt = Math.max(0, Math.min(60_000, Math.round(rttMs)));
  myRttMs =
    myRttMs > 0
      ? Math.round(myRttMs * 0.65 + rtt * 0.35)
      : rtt;
  applyClock(serverTimeMs, myRttMs);
  // Soft-update people list ping without full repaint thrash
  if (screen === "room") {
    softPaintRoom();
  }
}

function hasMedia(): boolean {
  return Boolean(playback?.videoUrl);
}

/** How many seconds are buffered ahead of `t` (0 if not in a range). */
function bufferedAheadFrom(t: number): number {
  try {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) {
      const start = b.start(i);
      const end = b.end(i);
      if (t >= start - 0.35 && t <= end + 0.05) {
        return Math.max(0, end - t);
      }
    }
  } catch {
    /* WebKit throws if not ready */
  }
  return 0;
}

/**
 * Follower sync: on host scrub / big drift → HTTP Range seek to that time,
 * then buffer *from there*. Soft path only rate-tweaks when already near.
 *
 * Old bug: clamped seeks into already-buffered ranges so mid-file scrub
 * downloaded 0→click instead of Range-jumping to the click.
 */
async function syncFollowerPlayback(
  state: PlaybackState,
  gen: number,
  needLoad: boolean,
): Promise<void> {
  const hostPlaying = state.isPlaying;
  const targetSec = expectedPos(state) / 1000;
  if (!Number.isFinite(targetSec)) return;

  const now = video.currentTime || 0;
  const drift = targetSec - now; // + = behind host
  const far = Math.abs(drift) >= FOLLOWER_HARD_DRIFT_SEC;

  // Host scrub / join mid-file: always jump to target. Browser issues Range.
  // Do this BEFORE the "wait for buffer" early-out or we never leave 0→N crawl.
  if (needLoad || far) {
    if (Math.abs(now - targetSec) > 0.75) {
      try {
        if (video.playbackRate !== 1) video.playbackRate = 1;
      } catch {
        /* */
      }
      await safeSeek(targetSec, gen);
      if (gen !== applyGen) return;
    }
  } else if (Math.abs(drift) >= FOLLOWER_SOFT_DRIFT_SEC) {
    const aheadSoft = bufferedAheadFrom(video.currentTime || 0);
    if (aheadSoft > 2) {
      try {
        video.playbackRate = drift > 0 ? 1.06 : 0.94;
      } catch {
        /* */
      }
    }
  } else {
    try {
      if (video.playbackRate !== 1) video.playbackRate = 1;
    } catch {
      /* */
    }
  }

  const cur = video.currentTime || 0;
  const ahead = bufferedAheadFrom(cur);

  // Not enough media at *current* playhead — wait (after seek this is the new spot)
  if (ahead < FOLLOWER_MIN_BUFFER_SEC * 0.5 && video.readyState < 3) {
    followerBuffering = true;
    try {
      video.pause();
    } catch {
      /* */
    }
    if (
      prepareStatus === "" ||
      prepareStatus.startsWith("Buffering") ||
      prepareStatus.startsWith("Seeking")
    ) {
      prepareStatus = far || needLoad ? "Seeking… buffering" : "Buffering stream…";
      softPaintRoom();
    }
    return;
  }

  if (!hostPlaying) {
    followerBuffering = false;
    if (
      prepareStatus.startsWith("Buffering") ||
      prepareStatus.startsWith("Seeking")
    ) {
      prepareStatus = "";
    }
    if (!video.paused) {
      try {
        video.pause();
      } catch {
        /* */
      }
    }
    return;
  }

  // Host playing: only play when we have a comfortable buffer ahead
  if (ahead < FOLLOWER_MIN_BUFFER_SEC) {
    followerBuffering = true;
    prepareStatus = `Buffering… ${ahead.toFixed(1)}s`;
    softPaintRoom();
    if (!video.paused && ahead < 1) {
      try {
        video.pause();
      } catch {
        /* */
      }
    }
    // If we have a little buffer, keep playing to avoid stop-start thrash
    if (ahead >= 1.5 && video.paused) {
      await safePlay();
    }
    return;
  }

  followerBuffering = false;
  if (
    prepareStatus.startsWith("Buffering") ||
    prepareStatus.startsWith("Seeking")
  ) {
    prepareStatus = "";
    softPaintRoom();
  }
  if (video.paused) await safePlay();
}

async function applyState(state: PlaybackState, force: boolean) {
  const gen = ++applyGen;
  const prevUrl = playback?.videoUrl ?? null;
  const urlChanged = prevUrl !== state.videoUrl;
  const ver = state.version;
  const prevPlaying = playback?.isPlaying;
  playback = state;

  if (!force && ver === lastVersion && !urlChanged) {
    softPaintRoom();
    return;
  }
  lastVersion = ver;

  // Host drives local file element — never yank src/seek from own heartbeats
  const drive = (!isHost && Boolean(state.videoUrl)) || force || urlChanged;

  if (drive && state.videoUrl) {
    applyingRemote = true;
    try {
      ensureVideoMounted();
      const needLoad =
        urlChanged || force || !videoHasUrl(state.videoUrl);
      if (needLoad) {
        // Start from ~host position once, then let progressive download buffer forward
        await loadVideoSrc(state.videoUrl);
        if (gen !== applyGen) return;
        const targetSec = expectedPos(state) / 1000;
        if (Number.isFinite(targetSec) && targetSec > 1) {
          // Initial seek — browser will Range-request; then we wait for buffer
          await safeSeek(targetSec, gen);
          if (gen !== applyGen) return;
        }
      }
      if (!isHost) {
        await syncFollowerPlayback(state, gen, needLoad);
      } else {
        // Host path when force/urlChanged (e.g. after open)
        const targetSec = expectedPos(state) / 1000;
        if (needLoad && Number.isFinite(targetSec)) {
          await safeSeek(targetSec, gen);
        }
        if (state.isPlaying) await safePlay();
        else {
          try {
            video.pause();
          } catch {
            /* */
          }
        }
      }
    } catch (e) {
      console.warn("applyState media failed", e);
      if (gen === applyGen) {
        error =
          e instanceof Error
            ? e.message
            : "Couldn't load the host stream (codec, network, or firewall)";
      }
    } finally {
      if (gen === applyGen) {
        queueMicrotask(() => {
          applyingRemote = false;
        });
      }
    }
  } else if (drive && !state.videoUrl) {
    applyingRemote = true;
    followerBuffering = false;
    try {
      video.pause();
      video.removeAttribute("src");
      while (video.firstChild) video.removeChild(video.firstChild);
      video.load();
    } catch {
      /* */
    }
    applyingRemote = false;
  }

  if (gen !== applyGen) return;
  if (urlChanged || force || prevPlaying === undefined) {
    paint();
  } else {
    softPaintRoom();
  }
}

function videoHasUrl(url: string): boolean {
  const token = tokenFromUrl(url);
  if (video.src && video.src.includes(token)) return true;
  const srcEl = video.querySelector("source");
  if (srcEl?.src && srcEl.src.includes(token)) return true;
  return false;
}

function tokenFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\/s\/([^/]+)/);
    return m?.[1] ?? url;
  } catch {
    return url;
  }
}

/**
 * Put video in the room shell when there is media. Never call while idle —
 * softPaint used to always mount a blank <video>, which ate the empty state
 * and left native controls with nothing to play.
 */
function ensureVideoMounted() {
  if (!hasMedia()) return;
  const mount = app.querySelector("#videoMount");
  if (!mount) return;
  mount.querySelector(".video-empty")?.remove();
  video.controls = true;
  if (video.parentElement !== mount) {
    mount.appendChild(video);
  }
}

/** Mount video only with media; otherwise show empty copy (no native controls). */
function syncVideoMount() {
  const mount = app.querySelector("#videoMount");
  if (!mount) return;
  if (hasMedia()) {
    ensureVideoMounted();
    return;
  }
  try {
    video.pause();
  } catch {
    /* */
  }
  video.controls = false;
  if (video.parentElement === mount) {
    video.remove();
  }
  // Clear any leftover src so a reparent doesn't flash old frames
  if (video.src || video.querySelector("source")) {
    video.removeAttribute("src");
    while (video.firstChild) video.removeChild(video.firstChild);
    try {
      video.load();
    } catch {
      /* */
    }
  }
  const emptyCopy = isHost
    ? {
        title: "Nothing playing",
        body: "Open a video or audio file to start the room.",
      }
    : {
        title: "Waiting for host",
        body: "Media shows up here when they start streaming.",
      };
  mount.innerHTML = `<div class="video-empty">
    <strong>${escapeHtml(emptyCopy.title)}</strong>
    <span>${escapeHtml(emptyCopy.body)}</span>
  </div>`;
}

/** Host player controls — rebuilt on soft paint when role / media changes. */
function hostPlayerBarHtml(): string {
  const media = hasMedia();
  return `
    <button type="button" class="primary" id="stream" ${busy ? "disabled" : ""}>Play media…</button>
    <button type="button" id="queueAdd" ${busy ? "disabled" : ""}>Add to queue</button>
    <button type="button" id="play" ${!media || busy ? "disabled" : ""}>Play</button>
    <button type="button" id="pause" ${!media || busy ? "disabled" : ""}>Pause</button>
    <span class="spacer"></span>
    <span class="bar-meta" data-flash-bar></span>
  `;
}

function viewerPlayerBarHtml(): string {
  const media = hasMedia();
  return `
    <span class="bar-meta" data-flash-bar>${media ? "Synced to host" : "Waiting…"}</span>
    <span class="spacer"></span>
  `;
}

function flashBarText(): { text: string; err: boolean } {
  if (error) return { text: error, err: true };
  if (prepareStatus) return { text: prepareStatus, err: false };
  if (status) return { text: status, err: false };
  if (!isHost) {
    return { text: hasMedia() ? "Synced to host" : "Waiting…", err: false };
  }
  return { text: "", err: false };
}

/** Last role used to build the room shell (detect host flip for full rebuild). */
let shellIsHost: boolean | null = null;

/**
 * Hard-reset media element. Always detach-safe: never leave WebKit mid-decode
 * under a parent about to be wiped by paint().
 */
function mediaMimeFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const ext = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1) : "";
    const map: Record<string, string> = {
      mp4: "video/mp4",
      m4v: "video/mp4",
      mov: "video/mp4",
      webm: "video/webm",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
      wmv: "video/x-ms-wmv",
      flv: "video/x-flv",
      ts: "video/mp2t",
      m2ts: "video/mp2t",
      mts: "video/mp2t",
      mpg: "video/mpeg",
      mpeg: "video/mpeg",
      ogv: "video/ogg",
      "3gp": "video/3gpp",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      wav: "audio/wav",
      flac: "audio/flac",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      opus: "audio/opus",
      wma: "audio/x-ms-wma",
      weba: "audio/webm",
      aiff: "audio/aiff",
      aif: "audio/aiff",
    };
    return map[ext] ?? "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}

function mediaErrorMessage(): string {
  const err = video.error;
  if (!err) return "Couldn't load the host stream";
  switch (err.code) {
    case 1:
      return "Playback aborted";
    case 2:
      return "Network error loading stream (firewall / host offline / bad URL)";
    case 3:
      return "Decode error — try Settings → FFmpeg prepare, or remux to mp4/webm";
    case 4:
      return "Format not supported by this system WebView — try another file or enable FFmpeg transcode";
    default:
      return `Media error ${err.code}${err.message ? `: ${err.message}` : ""}`;
  }
}

async function loadVideoSrc(url: string): Promise<void> {
  try {
    video.pause();
  } catch {
    /* */
  }
  video.removeAttribute("src");
  while (video.firstChild) video.removeChild(video.firstChild);
  video.load();

  // Aggressively prefer buffering — remote peers need a real download cushion
  video.preload = "auto";
  try {
    (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch =
      true;
  } catch {
    /* */
  }

  const source = document.createElement("source");
  source.src = url;
  source.type = mediaMimeFromUrl(url);
  video.appendChild(source);
  video.load();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const ok = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("loadeddata", ok);
      video.removeEventListener("canplay", ok);
      video.removeEventListener("error", bad);
      resolve();
    };
    const bad = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("loadeddata", ok);
      video.removeEventListener("canplay", ok);
      video.removeEventListener("error", bad);
      reject(new Error(mediaErrorMessage()));
    };
    video.addEventListener("loadedmetadata", ok, { once: true });
    video.addEventListener("loadeddata", ok, { once: true });
    video.addEventListener("canplay", ok, { once: true });
    video.addEventListener("error", bad, { once: true });
    source.addEventListener("error", bad, { once: true });
    window.setTimeout(() => {
      if (!settled) {
        settled = true;
        if (video.readyState < 1) {
          reject(
            new Error("Timed out loading stream (host unreachable or blocked)"),
          );
        } else {
          resolve();
        }
      }
    }, 20000);
  });
}

/**
 * Seek only when WebKit is ready — seeking too early crashes some Linux builds.
 * Cap to duration when known. Do NOT clamp to current `seekable` (often just the
 * already-downloaded slice) — that blocks mid-file scrub / HTTP Range jumps.
 */
async function safeSeek(targetSec: number, gen: number): Promise<void> {
  if (!Number.isFinite(targetSec) || targetSec < 0) return;
  if (video.readyState < 1) return; // HAVE_NOTHING

  let t = Math.max(0, targetSec);
  try {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      t = Math.min(t, Math.max(0, video.duration - 0.05));
    }
  } catch {
    /* duration not ready */
  }

  if (Math.abs((video.currentTime || 0) - t) <= 0.4) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", done);
      resolve();
    };
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", done, { once: true });
    // Range seeks over WAN can take longer than a local jump
    window.setTimeout(done, 8000);
    try {
      video.currentTime = t;
    } catch {
      done();
    }
  });
  if (gen !== applyGen) return;
}

async function safePlay(): Promise<void> {
  try {
    const p = video.play();
    if (p !== undefined) await p;
  } catch {
    // Autoplay / pipeline reject — not fatal
  }
}

function wireVideoHostEvents() {
  video.onplay = () => {
    if (applyingRemote || !isHost) return;
    void invoke("host_play", { positionMs: (video.currentTime || 0) * 1000 });
  };
  video.onpause = () => {
    if (applyingRemote || !isHost) return;
    void invoke("host_pause", { positionMs: (video.currentTime || 0) * 1000 });
  };
  video.onseeked = () => {
    if (applyingRemote || !isHost) return;
    void invoke("host_seek", {
      positionMs: (video.currentTime || 0) * 1000,
      isPlaying: !video.paused,
    });
  };
}

// Host keepalive every 5s while in room (playing OR paused).
setInterval(() => {
  if (screen !== "room") return;

  if (isHost && !applyingRemote) {
    void invoke("host_heartbeat", {
      positionMs: (video.currentTime || 0) * 1000,
      isPlaying: playback?.videoUrl ? !video.paused : false,
    });
    return;
  }

  // Follower: buffer-aware tick (no blind seek-to-live)
  if (!isHost && playback?.videoUrl && !applyingRemote) {
    void syncFollowerPlayback(playback, applyGen, false);
  }
}, 2000);

// Wire buffer events once — pause chase while network fills
video.addEventListener("waiting", () => {
  if (isHost || screen !== "room") return;
  followerBuffering = true;
  prepareStatus = "Buffering stream…";
  softPaintRoom();
});
video.addEventListener("playing", () => {
  if (isHost) return;
  if (followerBuffering && bufferedAheadFrom(video.currentTime || 0) >= 2) {
    followerBuffering = false;
    if (prepareStatus.startsWith("Buffering")) {
      prepareStatus = "";
      softPaintRoom();
    }
  }
});
video.addEventListener("progress", () => {
  // When enough is buffered, resume if host is playing
  if (isHost || !playback?.isPlaying || applyingRemote) return;
  const ahead = bufferedAheadFrom(video.currentTime || 0);
  if (ahead >= FOLLOWER_MIN_BUFFER_SEC && video.paused) {
    followerBuffering = false;
    if (prepareStatus.startsWith("Buffering")) prepareStatus = "";
    void safePlay();
    softPaintRoom();
  }
});

function normalizeEvent(raw: unknown): SyncEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = (o.kind ?? o.type) as string;
  if (!kind) return null;

  if (kind === "welcome") {
    return {
      kind: "welcome",
      session_id: pick(o, "session_id", "sessionId") as string,
      is_host: Boolean(pick(o, "is_host", "isHost")),
      state: pick(o, "state") as PlaybackState,
      members: normalizeMembers(pick(o, "members")),
      server_time_ms: Number(pick(o, "server_time_ms", "serverTimeMs") ?? 0),
    };
  }
  if (kind === "state") {
    return {
      kind: "state",
      state: pick(o, "state") as PlaybackState,
      server_time_ms: Number(pick(o, "server_time_ms", "serverTimeMs") ?? 0),
    };
  }
  if (kind === "members") {
    return {
      kind: "members",
      members: normalizeMembers(pick(o, "members")),
    };
  }
  if (kind === "latency") {
    return {
      kind: "latency",
      rtt_ms: Number(pick(o, "rtt_ms", "rttMs") ?? 0),
      server_time_ms: Number(pick(o, "server_time_ms", "serverTimeMs") ?? 0),
    };
  }
  if (kind === "chat") {
    const message = pick<Record<string, unknown>>(o, "message") ?? o;
    return {
      kind: "chat",
      message: {
        id: String(pick(message, "id") ?? ""),
        sessionId: String(pick(message, "sessionId", "session_id") ?? ""),
        nickname: String(pick(message, "nickname") ?? ""),
        text: String(pick(message, "text") ?? ""),
        serverTimeMs: Number(
          pick(message, "serverTimeMs", "server_time_ms") ?? 0,
        ),
      },
    };
  }
  if (kind === "connected") return { kind: "connected" };
  if (kind === "reconnecting") {
    return {
      kind: "reconnecting",
      attempt: Number(pick(o, "attempt") ?? 1),
      reason: String(pick(o, "reason") ?? "drop"),
    };
  }
  if (kind === "disconnected") {
    return {
      kind: "disconnected",
      reason: String(pick(o, "reason") ?? "closed"),
    };
  }
  if (kind === "error") {
    return {
      kind: "error",
      code: String(pick(o, "code") ?? "error"),
      message: String(pick(o, "message") ?? ""),
    };
  }
  if (kind === "room_closed") {
    return {
      kind: "room_closed",
      reason: String(pick(o, "reason") ?? "destroyed"),
      message: String(pick(o, "message") ?? "Room closed"),
    };
  }
  return null;
}

async function onSync(raw: unknown) {
  const ev = normalizeEvent(raw);
  if (!ev) return;

  switch (ev.kind) {
    case "connected":
      // Soft clear — welcome follows on (re)join
      if (error === "Connection lost" || status.startsWith("Reconnecting")) {
        status = "Connected…";
        error = "";
        paint();
      }
      break;
    case "reconnecting":
      // DO hibernation / network blip — stay in room, soft status
      error = "";
      setStatus(
        ev.attempt <= 1
          ? "Reconnecting…"
          : `Reconnecting… (try ${ev.attempt})`,
      );
      break;
    case "disconnected":
      // Permanent only (leave / room gone / fatal). Transient uses reconnecting.
      if (ev.reason === "room_closed") {
        // room_closed event handles kick
        break;
      }
      if (screen === "room") {
        setError("Connection lost");
      }
      break;
    case "welcome":
      sessionId = ev.session_id;
      isHost = ev.is_host;
      members = ev.members;
      // Rough clock until first latency pong (no RTT yet)
      applyClock(ev.server_time_ms, myRttMs > 0 ? myRttMs : undefined);
      // Switch shell first so <video> has a live mount before we load media.
      // Join-while-playing used to load then paint() and WebKitGTK often died.
      screen = "room";
      status = "";
      error = "";
      paint();
      await applyState(ev.state, true);
      break;
    case "state":
      applyClock(ev.server_time_ms, myRttMs > 0 ? myRttMs : undefined);
      await applyState(ev.state, false);
      break;
    case "latency":
      applyLatency(ev.rtt_ms, ev.server_time_ms);
      break;
    case "members":
      members = ev.members;
      isHost = members.some((m) => m.sessionId === sessionId && m.isHost);
      paint();
      break;
    case "chat":
      chat.push({ nick: ev.message.nickname, text: ev.message.text });
      if (chat.length > 200) chat = chat.slice(-150);
      paint();
      break;
    case "error":
      setError(ev.message || ev.code);
      break;
    case "room_closed":
      // Host left / room wiped — back to home
      void kickHome(ev.message || "Room closed");
      break;
  }
}

async function kickHome(message: string) {
  try {
    await invoke("room_leave");
  } catch {
    /* */
  }
  screen = "home";
  roomShellReady = false;
  shellIsHost = null;
  roomCode = "";
  isHost = false;
  sessionId = "";
  members = [];
  playback = null;
  chat = [];
  streamInfo = null;
  myRttMs = 0;
  clockOffsetMs = 0;
  video.removeAttribute("src");
  while (video.firstChild) video.removeChild(video.firstChild);
  video.load();
  busy = false;
  status = "";
  error = message;
  paint();
}

async function doCreate() {
  if (busy || !nick.trim()) return;
  busy = true;
  setStatus("Creating room…");
  localStorage.setItem("vidsync.nick", nick.trim());
  try {
    const code = await invoke<string>("room_create", {
      nickname: nick.trim(),
      apiBase,
    });
    roomCode = code;
    // Stay on home until welcome — premature room paint freezes isHost=false
    // and softPaint never rebuilds Play media / queue buttons.
    status = "Connecting…";
    error = "";
  } catch (e) {
    setError(friendlyErr(e));
  } finally {
    busy = false;
    paint();
  }
}

async function doJoin() {
  if (busy || !nick.trim() || joinCode.trim().length < 6) return;
  busy = true;
  setStatus("Joining…");
  localStorage.setItem("vidsync.nick", nick.trim());
  try {
    const code = joinCode.trim().toUpperCase();
    await invoke("room_join", {
      code,
      nickname: nick.trim(),
      apiBase,
    });
    roomCode = code;
    // Welcome event switches to room shell with correct isHost
    status = "Connecting…";
    error = "";
  } catch (e) {
    setError(friendlyErr(e));
  } finally {
    busy = false;
    paint();
  }
}

async function doLeave() {
  try {
    await invoke("room_leave");
  } catch {
    /* */
  }
  screen = "home";
  roomShellReady = false;
  shellIsHost = null;
  roomCode = "";
  isHost = false;
  sessionId = "";
  members = [];
  playback = null;
  chat = [];
  streamInfo = null;
  myRttMs = 0;
  clockOffsetMs = 0;
  status = "";
  error = "";
  video.removeAttribute("src");
  while (video.firstChild) video.removeChild(video.firstChild);
  video.load();
  paint();
}

async function pickVideoFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Media",
        extensions: [
          // video
          "mp4",
          "m4v",
          "webm",
          "mkv",
          "mov",
          "avi",
          "wmv",
          "flv",
          "f4v",
          "mpg",
          "mpeg",
          "mpe",
          "mp2",
          "m2v",
          "ts",
          "m2ts",
          "mts",
          "vob",
          "ogv",
          "3gp",
          "3g2",
          "asf",
          "rm",
          "rmvb",
          "divx",
          // audio
          "mp3",
          "m4a",
          "aac",
          "wav",
          "flac",
          "ogg",
          "oga",
          "opus",
          "wma",
          "aiff",
          "aif",
          "alac",
          "caf",
          "weba",
        ],
      },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!selected || typeof selected !== "string") return null;
  return selected;
}

/** Open file and switch room to it (adds to queue). */
async function doStreamFile() {
  if (!isHost || busy) return;
  const path = await pickVideoFile();
  if (!path) return;
  busy = true;
  prepareStatus = "";
  setStatus("Preparing video…");
  try {
    const info = await invoke<ServeInfo>("stream_start", {
      path,
      port: STREAM_PORT,
      upnp: USE_UPNP,
    });
    streamInfo = info;
    prepareStatus = "";
    applyingRemote = true;
    try {
      await loadVideoSrc(info.publicUrl ?? info.lanUrl);
      await video.play().catch(() => undefined);
    } finally {
      applyingRemote = false;
    }
    toast(info.fileName);
  } catch (e) {
    prepareStatus = "";
    setError(friendlyErr(e));
  } finally {
    busy = false;
    paint();
  }
}

/** Add file to queue without forcing a switch (unless nothing playing). */
async function doQueueAdd() {
  if (!isHost || busy) return;
  const path = await pickVideoFile();
  if (!path) return;
  busy = true;
  prepareStatus = "";
  setStatus("Preparing video…");
  try {
    const info = await invoke<ServeInfo>("queue_add_file", { path });
    streamInfo = info;
    prepareStatus = "";
    toast(`Queued ${info.fileName}`);
  } catch (e) {
    prepareStatus = "";
    setError(friendlyErr(e));
  } finally {
    busy = false;
    paint();
  }
}

async function openSettings() {
  settingsReturn = screen === "room" ? "room" : "home";
  try {
    mediaSettings = await invoke<MediaSettings>("get_media_settings");
    ffmpegInfo = await invoke<FfmpegStatus>("ffmpeg_status");
  } catch (e) {
    setError(friendlyErr(e));
    return;
  }
  screen = "settings";
  paint();
}

function readSettingsForm(): MediaSettings | null {
  const enabled = app.querySelector<HTMLInputElement>("#setEnabled");
  const path = app.querySelector<HTMLInputElement>("#setFfmpeg");
  const mode = app.querySelector<HTMLSelectElement>("#setMode");
  const remux = app.querySelector<HTMLTextAreaElement>("#setRemux");
  const trans = app.querySelector<HTMLTextAreaElement>("#setTranscode");
  if (!enabled || !path || !mode || !remux || !trans) return null;
  return {
    enabled: enabled.checked,
    ffmpegPath: path.value.trim(),
    mode: mode.value,
    remuxArgs: remux.value.trim(),
    transcodeArgs: trans.value.trim(),
  };
}

async function saveSettingsFromForm() {
  const s = readSettingsForm();
  if (!s) return;
  try {
    await invoke("set_media_settings", { settings: s });
    mediaSettings = s;
    ffmpegInfo = await invoke<FfmpegStatus>("ffmpeg_status");
    toast("Settings saved");
    paint();
  } catch (e) {
    setError(friendlyErr(e));
  }
}

async function resetSettingsArgs() {
  try {
    const d = await invoke<MediaSettings>("default_media_settings");
    const cur = readSettingsForm() ?? mediaSettings ?? d;
    mediaSettings = {
      ...cur,
      remuxArgs: d.remuxArgs,
      transcodeArgs: d.transcodeArgs,
      mode: d.mode,
      enabled: d.enabled,
    };
    paint();
    toast("Restored default args");
  } catch (e) {
    setError(friendlyErr(e));
  }
}

async function clearMediaCache() {
  try {
    const n = await invoke<number>("clear_media_cache");
    toast(`Cleared ${n} cached file(s)`);
  } catch (e) {
    setError(friendlyErr(e));
  }
}

function platformBadge(platform?: string): string {
  const p = (platform || "unknown").toLowerCase();
  const map: Record<string, { label: string; cls: string; title: string }> = {
    windows: { label: "Win", cls: "os-win", title: "Windows" },
    linux: { label: "Lin", cls: "os-lin", title: "Linux" },
    macos: { label: "Mac", cls: "os-mac", title: "macOS" },
    web: { label: "Web", cls: "os-web", title: "Web" },
    unknown: { label: "?", cls: "os-unk", title: "Unknown" },
  };
  const m = map[p] ?? map.unknown;
  return `<span class="os-badge ${m.cls}" title="${escapeAttr(m.title)}">${m.label}</span>`;
}

async function doQueuePlay(index: number) {
  if (!isHost || busy) return;
  try {
    await invoke("queue_play", { index });
  } catch (e) {
    setError(friendlyErr(e));
  }
}

async function doQueueRemove(index: number) {
  if (!isHost || busy) return;
  try {
    await invoke("queue_remove", { index });
  } catch (e) {
    setError(friendlyErr(e));
  }
}

async function doQueueClear() {
  if (!isHost || busy) return;
  try {
    await invoke("queue_clear");
    streamInfo = null;
  } catch (e) {
    setError(friendlyErr(e));
  }
}

async function doChat() {
  const t = chatDraft.trim();
  if (!t) return;
  chatDraft = "";
  try {
    await invoke("room_chat", { text: t });
  } catch (e) {
    setError(friendlyErr(e));
  }
  paint();
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast("Copied"),
    () => setError("Could not copy"),
  );
}

function friendlyErr(e: unknown): string {
  const s = String(e).replace(/^Error:\s*/i, "");
  if (/timeout|network|fetch|connect/i.test(s)) return "Can't reach the server";
  if (/not found|404|invalid_code/i.test(s)) return "Room not found";
  if (/room_full/i.test(s)) return "Room is full";
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const path =
      x.pathname.length > 22 ? `${x.pathname.slice(0, 22)}…` : x.pathname;
    return `${x.hostname}${path}`;
  } catch {
    return u.length > 40 ? `${u.slice(0, 40)}…` : u;
  }
}

/** Semver compare: a > b → 1, a < b → -1, equal → 0. Strips leading v. */
function cmpSemver(a: string, b: string): number {
  const parse = (s: string) =>
    s
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((p) => {
        const n = Number(p);
        return Number.isFinite(n) ? n : 0;
      });
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const d = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

async function checkForUpdates() {
  try {
    if (!appVersion) {
      try {
        appVersion = await getVersion();
      } catch {
        appVersion = "";
      }
    }
    const update = await check();
    if (!update) {
      updateUi = { phase: "idle" };
      pendingUpdate = null;
      return;
    }
    // Guard: never prompt if remote is not strictly newer (stale manifest / re-check after install)
    if (appVersion && cmpSemver(update.version, appVersion) <= 0) {
      console.info(
        `skip update: remote ${update.version} <= installed ${appVersion}`,
      );
      updateUi = { phase: "idle" };
      pendingUpdate = null;
      return;
    }
    pendingUpdate = update;
    updateUi = { phase: "available", version: update.version };
    paint();
  } catch (e) {
    // Offline / first boot without endpoint — silent
    console.warn("update check failed", e);
  }
}

async function doInstallUpdate() {
  if (!pendingUpdate || updateBusy) return;
  updateBusy = true;
  const version = pendingUpdate.version;
  updateUi = { phase: "downloading", version, pct: null };
  paint();
  try {
    let downloaded = 0;
    let total: number | null = null;
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        updateUi = { phase: "downloading", version, pct: total ? 0 : null };
        paint();
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const pct =
          total && total > 0
            ? Math.min(99, Math.round((downloaded / total) * 100))
            : null;
        updateUi = { phase: "downloading", version, pct };
        paint();
      } else if (event.event === "Finished") {
        updateUi = { phase: "ready", version };
        paint();
      }
    });
    updateUi = { phase: "ready", version };
    paint();
    // Windows exits during install; relaunch for Linux/macOS
    await relaunch();
  } catch (e) {
    updateUi = {
      phase: "error",
      message: friendlyErr(e) || "Update failed",
    };
    pendingUpdate = null;
    paint();
  } finally {
    updateBusy = false;
  }
}

function updateBannerHtml(): string {
  if (updateUi.phase === "idle") return "";
  if (updateUi.phase === "available") {
    return `<div class="update-banner" role="status">
      <span>Update <strong>v${escapeHtml(updateUi.version)}</strong> ready</span>
      <button type="button" class="primary sm" id="updateInstall" ${updateBusy ? "disabled" : ""}>Install &amp; restart</button>
      <button type="button" class="ghost sm" id="updateDismiss">Later</button>
    </div>`;
  }
  if (updateUi.phase === "downloading") {
    const pct =
      updateUi.pct != null ? `${updateUi.pct}%` : "downloading…";
    return `<div class="update-banner" role="status">
      <span>Installing v${escapeHtml(updateUi.version)} · ${escapeHtml(pct)}</span>
    </div>`;
  }
  if (updateUi.phase === "ready") {
    return `<div class="update-banner" role="status">
      <span>Update installed — restarting…</span>
    </div>`;
  }
  return `<div class="update-banner err" role="status">
    <span>${escapeHtml(updateUi.message)}</span>
    <button type="button" class="ghost sm" id="updateDismiss">Dismiss</button>
  </div>`;
}

function bindUiOnce() {
  app.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || btn.hasAttribute("disabled")) return;
    switch (btn.id) {
      case "updateInstall":
        void doInstallUpdate();
        break;
      case "updateDismiss":
        updateUi = { phase: "idle" };
        pendingUpdate = null;
        paint();
        break;
      case "create":
        void doCreate();
        break;
      case "joinBtn":
        void doJoin();
        break;
      case "leave":
        void doLeave();
        break;
      case "openSettings":
        void openSettings();
        break;
      case "settingsBack":
        screen = settingsReturn;
        paint();
        break;
      case "settingsSave":
        void saveSettingsFromForm();
        break;
      case "settingsResetArgs":
        void resetSettingsArgs();
        break;
      case "settingsClearCache":
        void clearMediaCache();
        break;
      case "copyCode":
        copy(roomCode);
        break;
      case "stream":
        void doStreamFile();
        break;
      case "queueAdd":
        void doQueueAdd();
        break;
      case "queueClear":
        void doQueueClear();
        break;
      case "play":
        void video.play();
        void invoke("host_play", {
          positionMs: (video.currentTime || 0) * 1000,
        });
        break;
      case "pause":
        video.pause();
        void invoke("host_pause", {
          positionMs: (video.currentTime || 0) * 1000,
        });
        break;
      case "copyShare":
        if (streamInfo) copy(streamInfo.publicUrl ?? streamInfo.lanUrl);
        break;
      case "send":
        void doChat();
        break;
      default:
        break;
    }

    // Queue item actions
    const remItem = (e.target as HTMLElement).closest<HTMLElement>("[data-q-remove]");
    if (remItem && isHost) {
      const i = Number(remItem.dataset.qRemove);
      if (Number.isFinite(i)) void doQueueRemove(i);
      return;
    }
    const playItem = (e.target as HTMLElement).closest<HTMLElement>("[data-q-play]");
    if (playItem && isHost) {
      const i = Number(playItem.dataset.qPlay);
      if (Number.isFinite(i)) void doQueuePlay(i);
    }
  });

  app.addEventListener("input", (e) => {
    const el = e.target;
    if (el instanceof HTMLTextAreaElement) {
      if (el.id === "setRemux" || el.id === "setTranscode" || el.id === "setFfmpeg") {
        /* live form — saved on button */
      }
      return;
    }
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement))
      return;
    if (el.id === "nick") {
      nick = el.value;
      const create = app.querySelector<HTMLButtonElement>("#create");
      if (create) create.disabled = busy || !nick.trim();
    } else if (el.id === "join") {
      joinCode = el.value.toUpperCase();
      el.value = joinCode;
      const joinBtn = app.querySelector<HTMLButtonElement>("#joinBtn");
      if (joinBtn) joinBtn.disabled = busy || joinCode.trim().length < 6;
    } else if (el.id === "chat") {
      chatDraft = el.value;
    }
  });

  app.addEventListener("change", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement))
      return;
    if (el.id === "setEnabled" || el.id === "setMode") {
      /* form fields */
    }
  });

  app.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.id === "chat") {
      e.preventDefault();
      void doChat();
    }
    if (e.key === "Enter" && t.id === "join") {
      e.preventDefault();
      void doJoin();
    }
    if (e.key === "Enter" && t.id === "nick" && !e.shiftKey) {
      e.preventDefault();
      void doCreate();
    }
  });
}

function softPaintRoom() {
  if (screen !== "room" || !app.querySelector(".room-layout")) {
    paint();
    return;
  }

  // Host role changed after shell built (create/join paints before welcome) —
  // full rebuild so Play media / Add to queue appear.
  if (shellIsHost !== isHost) {
    roomShellReady = false;
    paint();
    return;
  }

  const bar = app.querySelector(".player-bar");
  if (bar) {
    // Keep host buttons alive; only rewrite if structure missing
    const hasStreamBtn = Boolean(bar.querySelector("#stream"));
    if (isHost && !hasStreamBtn) {
      bar.innerHTML = hostPlayerBarHtml();
    } else if (!isHost && hasStreamBtn) {
      bar.innerHTML = viewerPlayerBarHtml();
    } else if (isHost) {
      const play = bar.querySelector<HTMLButtonElement>("#play");
      const pause = bar.querySelector<HTMLButtonElement>("#pause");
      const stream = bar.querySelector<HTMLButtonElement>("#stream");
      const qAdd = bar.querySelector<HTMLButtonElement>("#queueAdd");
      const media = hasMedia();
      if (play) play.disabled = !media || busy;
      if (pause) pause.disabled = !media || busy;
      if (stream) stream.disabled = busy;
      if (qAdd) qAdd.disabled = busy;
    }
  }

  const flash = flashBarText();
  const flashBar =
    app.querySelector("[data-flash-bar]") ?? app.querySelector(".bar-meta");
  if (flashBar) {
    flashBar.className = flash.err ? "bar-meta err" : "bar-meta";
    flashBar.setAttribute("data-flash-bar", "");
    // Host: only show status/error in the meta slot; empty is fine
    if (isHost || flash.text) {
      flashBar.textContent = flash.text;
    }
  }

  const peopleTitle = app.querySelector("[data-people-title]");
  if (peopleTitle) {
    peopleTitle.textContent = `People · ${members.length}`;
  }

  const people = app.querySelector(".people");
  if (people) {
    people.innerHTML = peopleListHtml(members);
  }
  const queue = app.querySelector(".queue");
  if (queue) {
    queue.innerHTML =
      (playback?.queue ?? [])
        .map((u, i) => {
          const active = playback?.queueIndex === i;
          if (isHost) {
            return `<li class="q-item ${active ? "active" : ""}">
              <button type="button" class="q-play" data-q-play="${i}" title="Play">
                <span class="dot">${active ? "●" : "○"}</span>
                <span class="qtext" title="${escapeAttr(u)}">${escapeHtml(shortUrl(u))}</span>
              </button>
              <button type="button" class="ghost sm q-x" data-q-remove="${i}" title="Remove" aria-label="Remove">×</button>
            </li>`;
          }
          return `<li class="${active ? "active" : ""}">
            <span class="dot">${active ? "●" : "○"}</span>
            <span class="qtext" title="${escapeAttr(u)}">${escapeHtml(shortUrl(u))}</span>
          </li>`;
        })
        .join("") ||
      `<li class="empty" style="color:var(--faint)">${isHost ? "Add videos with Play media or Add to queue" : "Empty"}</li>`;
  }

  const qHead = app.querySelector(".panel-head");
  if (qHead) {
    const clear = qHead.querySelector("#queueClear");
    const wantClear = isHost && (playback?.queue?.length ?? 0) > 0;
    if (wantClear && !clear) {
      qHead.insertAdjacentHTML(
        "beforeend",
        `<button type="button" class="ghost sm" id="queueClear">Clear</button>`,
      );
    } else if (!wantClear && clear) {
      clear.remove();
    }
  }

  const chatLog = app.querySelector("#chatLog");
  if (chatLog) {
    chatLog.innerHTML =
      chat
        .map(
          (c) =>
            `<div class="line"><span class="nick">${escapeHtml(c.nick)}</span>${escapeHtml(c.text)}</div>`,
        )
        .join("") || `<div class="empty">Say something</div>`;
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  const pill = app.querySelector(".pill");
  if (pill) {
    pill.className = `pill ${isHost ? "host" : "viewer"}`;
    pill.textContent = isHost ? "Host" : "Watching";
  }

  syncVideoMount();
}

function paint() {
  if (screen === "settings") {
    roomShellReady = false;
    paintSettings();
    return;
  }

  if (screen === "home") {
    roomShellReady = false;
    const flash = error
      ? `<p class="flash err" data-flash>${escapeHtml(error)}</p>`
      : status
        ? `<p class="flash ok" data-flash>${escapeHtml(status)}</p>`
        : `<p class="flash" data-flash></p>`;

    app.innerHTML = `
      <div class="screen home">
        ${updateBannerHtml()}
        <div class="home-card">
          <div class="brand">
            <h1 class="brand-mark">VidSync</h1>
            <p class="brand-tag">Watch together. One room, one stream.</p>
            ${
              appVersion
                ? `<p class="brand-ver">v${escapeHtml(appVersion)}</p>`
                : ""
            }
          </div>
          <div class="stack">
            <label class="field">
              <span>Name</span>
              <input id="nick" autocomplete="nickname" maxlength="24"
                placeholder="How you show up"
                value="${escapeAttr(nick)}" ${busy ? "disabled" : ""} />
            </label>
            <button type="button" class="primary" id="create"
              ${busy || !nick.trim() ? "disabled" : ""}>
              ${busy && status.includes("Creating") ? "Creating…" : "New room"}
            </button>
            <div class="divider">or join</div>
            <div class="join-row">
              <input id="join" autocomplete="off" spellcheck="false"
                placeholder="Room code"
                value="${escapeAttr(joinCode)}" ${busy ? "disabled" : ""} />
              <button type="button" id="joinBtn"
                ${busy || joinCode.trim().length < 6 ? "disabled" : ""}>
                Join
              </button>
            </div>
            <button type="button" class="ghost" id="openSettings">Settings</button>
            ${flash}
          </div>
        </div>
      </div>`;
    return;
  }


  // Soft path: room chrome already built — don't reparent <video>
  if (
    roomShellReady &&
    shellIsHost === isHost &&
    app.querySelector(".room-layout") &&
    app.querySelector("#videoMount")
  ) {
    softPaintRoom();
    return;
  }

  const media = hasMedia();
  const fileLabel = streamInfo?.fileName ?? "";
  const emptyCopy = isHost
    ? {
        title: "Nothing playing",
        body: "Open a video or audio file to start the room.",
      }
    : {
        title: "Waiting for host",
        body: "Media shows up here when they start streaming.",
      };

  const flash = flashBarText();
  const flashSlot = flash.text
    ? `<span class="bar-meta${flash.err ? " err" : ""}" data-flash-bar>${escapeHtml(flash.text)}</span>`
    : `<span class="bar-meta" data-flash-bar></span>`;

  // CRITICAL: detach <video> before thrashing innerHTML. WebKitGTK crashes when a
  // playing/loading media element is destroyed as a descendant of replaced markup
  // (common path: guest joins while host already has media).
  if (video.parentNode) {
    video.remove();
  }

  app.innerHTML = `
    <div class="screen room-layout">
      ${updateBannerHtml()}
      <header class="room-header">
        <div class="room-id">
          <code>${escapeHtml(roomCode)}</code>
          <span class="pill ${isHost ? "host" : "viewer"}">${isHost ? "Host" : "Watching"}</span>
        </div>
        <div class="header-actions">
          <button type="button" class="ghost" id="openSettings">Settings</button>
          <button type="button" class="ghost" id="copyCode">Copy code</button>
          <button type="button" class="ghost" id="leave">Leave</button>
        </div>
      </header>
      <div class="room-body">
        <div class="player-pane">
          <div class="video-shell" id="videoMount">
            ${
              !media
                ? `<div class="video-empty">
                    <strong>${escapeHtml(emptyCopy.title)}</strong>
                    <span>${escapeHtml(emptyCopy.body)}</span>
                  </div>`
                : ""
            }
          </div>
          <div class="player-bar">
            ${
              isHost
                ? `
              <button type="button" class="primary" id="stream" ${busy ? "disabled" : ""}>Play media…</button>
              <button type="button" id="queueAdd" ${busy ? "disabled" : ""}>Add to queue</button>
              <button type="button" id="play" ${!media || busy ? "disabled" : ""}>Play</button>
              <button type="button" id="pause" ${!media || busy ? "disabled" : ""}>Pause</button>
              <span class="spacer"></span>
              ${flashSlot}
            `
                : `${flashSlot}<span class="spacer"></span>`
            }
          </div>
          ${
            streamInfo
              ? `<div class="share-strip">
                  <span class="label">Sharing</span>
                  <span class="name" title="${escapeAttr(streamInfo.publicUrl ?? streamInfo.lanUrl)}">${escapeHtml(fileLabel || "stream")}</span>
                  <button type="button" class="ghost" id="copyShare">Copy link</button>
                </div>`
              : ""
          }
        </div>
        <aside class="side">
          <div class="panel">
            <p class="panel-title" data-people-title>People · ${members.length}</p>
            <ul class="people">
              ${peopleListHtml(members)}
            </ul>
          </div>
          <div class="panel">
            <div class="panel-head">
              <p class="panel-title">Queue</p>
              ${
                isHost && (playback?.queue?.length ?? 0) > 0
                  ? `<button type="button" class="ghost sm" id="queueClear">Clear</button>`
                  : ""
              }
            </div>
            <ul class="queue">
              ${
                (playback?.queue ?? [])
                  .map((u, i) => {
                    const active = playback?.queueIndex === i;
                    if (isHost) {
                      return `<li class="q-item ${active ? "active" : ""}">
                        <button type="button" class="q-play" data-q-play="${i}" title="Play">
                          <span class="dot">${active ? "●" : "○"}</span>
                          <span class="qtext" title="${escapeAttr(u)}">${escapeHtml(shortUrl(u))}</span>
                        </button>
                        <button type="button" class="ghost sm q-x" data-q-remove="${i}" title="Remove" aria-label="Remove">×</button>
                      </li>`;
                    }
                    return `<li class="${active ? "active" : ""}">
                      <span class="dot">${active ? "●" : "○"}</span>
                      <span class="qtext" title="${escapeAttr(u)}">${escapeHtml(shortUrl(u))}</span>
                    </li>`;
                  })
                  .join("") ||
                `<li class="empty" style="color:var(--faint)">${isHost ? "Add videos with Play media or Add to queue" : "Empty"}</li>`
              }
            </ul>
          </div>
          <div class="panel chat-panel">
            <p class="panel-title">Chat</p>
            <div class="chat-log" id="chatLog">
              ${
                chat
                  .map(
                    (c) =>
                      `<div class="line"><span class="nick">${escapeHtml(c.nick)}</span>${escapeHtml(c.text)}</div>`,
                  )
                  .join("") || `<div class="empty">Say something</div>`
              }
            </div>
            <div class="chat-compose">
              <input id="chat" maxlength="280" placeholder="Message"
                value="${escapeAttr(chatDraft)}" ${busy ? "disabled" : ""} />
              <button type="button" id="send" ${busy ? "disabled" : ""}>Send</button>
            </div>
          </div>
        </aside>
      </div>
    </div>`;

  if (media) {
    ensureVideoMounted();
  } else {
    // video already detached above; empty copy is in markup
    video.controls = false;
  }

  const log = app.querySelector("#chatLog");
  if (log) log.scrollTop = log.scrollHeight;
  roomShellReady = true;
  shellIsHost = isHost;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function paintSettings() {
  const s =
    mediaSettings ??
    ({
      enabled: true,
      ffmpegPath: "",
      mode: "auto",
      remuxArgs: "",
      transcodeArgs: "",
    } satisfies MediaSettings);
  const ff = ffmpegInfo;
  const ffLine = ff?.available
    ? `Found: ${escapeHtml(ff.versionLine || ff.path || "ffmpeg")}`
    : "FFmpeg not found on PATH — install it or set path below";

  const mode = s.mode || "auto";
  app.innerHTML = `
    <div class="screen settings">
      <header class="room-header">
        <div class="room-id"><strong>Settings</strong></div>
        <div class="header-actions">
          <button type="button" class="ghost" id="settingsBack">Back</button>
        </div>
      </header>
      <div class="settings-body">
        <section class="settings-block">
          <h2>Host media (FFmpeg)</h2>
          <p class="lede-sm">When you open a local file, the host can remux or transcode to H.264/AAC for max client compatibility. Viewers never run FFmpeg.</p>
          <p class="ff-status ${ff?.available ? "ok" : "bad"}">${ffLine}</p>
          <label class="check">
            <input type="checkbox" id="setEnabled" ${s.enabled ? "checked" : ""} />
            <span>Prepare media with FFmpeg before sharing</span>
          </label>
          <label class="field">
            <span>FFmpeg path (optional)</span>
            <input id="setFfmpeg" type="text" spellcheck="false"
              placeholder="empty = search PATH"
              value="${escapeAttr(s.ffmpegPath)}" />
          </label>
          <label class="field">
            <span>Mode</span>
            <select id="setMode">
              <option value="auto" ${mode === "auto" ? "selected" : ""}>Auto (remux if possible, else high-quality encode)</option>
              <option value="remux" ${mode === "remux" ? "selected" : ""}>Always remux (stream copy, no quality loss)</option>
              <option value="transcode" ${mode === "transcode" ? "selected" : ""}>Always transcode (H.264 + AAC)</option>
              <option value="off" ${mode === "off" ? "selected" : ""}>Off — serve original file</option>
            </select>
          </label>
          <label class="field">
            <span>Remux args (lossless copy)</span>
            <textarea id="setRemux" rows="3" spellcheck="false">${escapeHtml(s.remuxArgs)}</textarea>
          </label>
          <label class="field">
            <span>Transcode args (compatible, high quality)</span>
            <textarea id="setTranscode" rows="4" spellcheck="false">${escapeHtml(s.transcodeArgs)}</textarea>
          </label>
          <p class="hint">Command shape: <code>ffmpeg -y -i INPUT …args… OUTPUT.mp4</code>. Defaults keep quality (copy / CRF 18) and strip junk tracks (tmcd, subs).</p>
          <div class="settings-actions">
            <button type="button" class="primary" id="settingsSave">Save</button>
            <button type="button" id="settingsResetArgs">Reset defaults</button>
            <button type="button" class="ghost" id="settingsClearCache">Clear media cache</button>
          </div>
        </section>
      </div>
    </div>`;
}

async function boot() {
  bindUiOnce();
  wireVideoHostEvents();
  try {
    apiBase = await invoke<string>("default_api");
  } catch {
    apiBase = DEFAULT_API;
  }
  try {
    appVersion = await getVersion();
  } catch {
    appVersion = "";
  }
  await listen("sync-event", (e) => {
    void onSync(e.payload);
  });
  await listen("media-prepare", (e) => {
    const p = e.payload as {
      phase?: string;
      message?: string;
      pct?: number | null;
    };
    const pct =
      p.pct != null && Number.isFinite(p.pct) ? ` ${p.pct}%` : "";
    prepareStatus = `${p.message || p.phase || "Working…"}${pct}`;
    status = prepareStatus;
    // Soft update only — full paint during prepare would thrash
    const el = app.querySelector(".bar-meta");
    if (el) {
      el.className = "bar-meta";
      el.textContent = prepareStatus;
    } else if (screen === "room") {
      softPaintRoom();
    }
  });
  paint();
  void checkForUpdates();
}

void boot();
