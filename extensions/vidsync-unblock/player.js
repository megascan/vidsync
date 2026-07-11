/**
 * Extension-owned player window.
 * Host uses native controls here; user play/pause/seek → room tab → DO.
 * Room also pushes state (followers / queue URL change).
 */

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const urlEl = document.getElementById("url");
const emptyEl = document.getElementById("empty");

/** @type {string | null} */
let currentUrl = null;
/** Ignore local play/pause/seek events caused by room→player sync */
let applyingRemote = false;
/** Hold ignore window past async video.play() so events don't look user-driven */
let applyingRemoteUntil = 0;
let lastReportedMs = 0;
/** Suppress user_control spam from rapid events */
let lastControlAt = 0;
/** @type {string | null} */
let lastControlKey = null;

function beginRemoteApply() {
  applyingRemote = true;
  applyingRemoteUntil = Date.now() + 450;
}

function endRemoteApply() {
  queueMicrotask(() => {
    window.setTimeout(() => {
      if (Date.now() >= applyingRemoteUntil) applyingRemote = false;
    }, 400);
  });
}

function isRemoteApply() {
  return applyingRemote || Date.now() < applyingRemoteUntil;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function loadUrl(url) {
  if (!url || typeof url !== "string") {
    emptyEl.hidden = false;
    video.hidden = true;
    setStatus("No URL");
    return;
  }
  emptyEl.hidden = true;
  video.hidden = false;
  currentUrl = url;
  urlEl.textContent = url;
  setStatus("Loading stream (Range)…");
  // Extension page + host_permissions: browser streams with Range, no page CORS
  video.removeAttribute("crossorigin");
  video.preload = "auto";
  video.src = url;
  video.load();
}

function applyState(state) {
  if (!state || !currentUrl) return;
  beginRemoteApply();
  try {
    const targetSec = Math.max(0, (state.positionMs ?? 0) / 1000);
    const nowSec = video.currentTime || 0;
    const drift = Math.abs(targetSec - nowSec);

    if (state.videoUrl && state.videoUrl !== currentUrl) {
      loadUrl(state.videoUrl);
    }

    if (drift > 0.45 && Number.isFinite(targetSec)) {
      video.currentTime = targetSec;
    }

    if (state.isPlaying) {
      if (video.paused) {
        void video.play().catch(() => {
          setStatus("Click play in this window (autoplay blocked)");
        });
      }
    } else if (!video.paused) {
      video.pause();
    }
    setStatus(state.isPlaying ? "Playing (synced)" : "Paused (synced)");
  } finally {
    endRemoteApply();
  }
}

function applyControl(msg) {
  if (!msg || !currentUrl) return;
  beginRemoteApply();
  try {
    const kind = msg.controlType ?? msg.type;
    if (typeof msg.positionMs === "number") {
      video.currentTime = Math.max(0, msg.positionMs / 1000);
    }
    if (kind === "play") {
      void video.play().catch(() => setStatus("Click play here (autoplay)"));
      setStatus("Play");
    } else if (kind === "pause") {
      video.pause();
      setStatus("Pause");
    } else if (kind === "seek") {
      setStatus(`Seek ${Math.round((msg.positionMs ?? 0) / 1000)}s`);
      if (msg.isPlaying) void video.play().catch(() => {});
      else video.pause();
    }
  } finally {
    endRemoteApply();
  }
}

function reportPosition() {
  if (!currentUrl || isRemoteApply()) return;
  const positionMs = Math.round((video.currentTime || 0) * 1000);
  lastReportedMs = positionMs;
  chrome.runtime.sendMessage({
    type: "player_tick",
    positionMs,
    isPlaying: !video.paused,
    durationMs: Number.isFinite(video.duration)
      ? Math.round(video.duration * 1000)
      : null,
    videoUrl: currentUrl,
  });
}

/**
 * User-driven control in this window → room tab (host only applies to DO).
 * @param {"play" | "pause" | "seek"} controlType
 */
function reportUserControl(controlType) {
  if (!currentUrl || isRemoteApply()) return;
  const positionMs = Math.round((video.currentTime || 0) * 1000);
  const isPlaying = !video.paused;
  const key = `${controlType}:${positionMs}:${isPlaying ? 1 : 0}`;
  const now = Date.now();
  // Dedup identical control within 120ms (play+seeked etc.)
  if (key === lastControlKey && now - lastControlAt < 120) return;
  lastControlKey = key;
  lastControlAt = now;

  chrome.runtime.sendMessage({
    type: "player_user_control",
    controlType,
    positionMs,
    isPlaying,
    videoUrl: currentUrl,
  });
  lastReportedMs = positionMs;
  setStatus(
    controlType === "play"
      ? "Playing (host)"
      : controlType === "pause"
        ? "Paused (host)"
        : `Seek ${Math.round(positionMs / 1000)}s (host)`,
  );
}

video.addEventListener("loadedmetadata", () => {
  setStatus(
    `Stream ready${Number.isFinite(video.duration) ? ` (${Math.round(video.duration / 60)} min)` : ""} — use controls here`,
  );
});
video.addEventListener("error", () => {
  const code = video.error?.code;
  setStatus(
    code === 4
      ? "Cannot load media (unsupported / blocked). Check URL."
      : "Media error — check URL / network",
  );
});

// Host chrome controls → DO via room lobby
video.addEventListener("play", () => {
  if (isRemoteApply()) return;
  reportUserControl("play");
  reportPosition();
});
video.addEventListener("pause", () => {
  if (isRemoteApply()) return;
  reportUserControl("pause");
  reportPosition();
});
video.addEventListener("seeked", () => {
  if (isRemoteApply()) return;
  reportUserControl("seek");
  reportPosition();
});

// Position ticks for host heartbeat while playing
setInterval(reportPosition, 1000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "player_load") {
    loadUrl(msg.url);
    if (msg.state) applyState(msg.state);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "player_state") {
    applyState(msg.state);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "player_control") {
    applyControl(msg);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "player_ping") {
    sendResponse({
      ok: true,
      url: currentUrl,
      positionMs: Math.round((video.currentTime || 0) * 1000),
      isPlaying: !video.paused,
    });
    return false;
  }

  return false;
});

// Boot from query string
const params = new URLSearchParams(location.search);
const bootUrl = params.get("url");
if (bootUrl) {
  try {
    loadUrl(decodeURIComponent(bootUrl));
  } catch {
    loadUrl(bootUrl);
  }
} else {
  emptyEl.hidden = false;
  video.hidden = true;
}

// Announce ready to background
chrome.runtime.sendMessage({ type: "player_ready" }).catch(() => {});
