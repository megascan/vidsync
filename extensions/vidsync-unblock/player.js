/**
 * Extension-owned player window.
 * Plays media under chrome-extension:// with host_permissions — no page CORS.
 * Receives play/pause/seek from the room tab; reports position back for sync.
 */

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const urlEl = document.getElementById("url");
const emptyEl = document.getElementById("empty");

/** @type {string | null} */
let currentUrl = null;
let applyingRemote = false;
let lastReportedMs = 0;

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
  applyingRemote = true;
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
    queueMicrotask(() => {
      applyingRemote = false;
    });
  }
}

function applyControl(msg) {
  if (!msg || !currentUrl) return;
  applyingRemote = true;
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
    queueMicrotask(() => {
      applyingRemote = false;
    });
  }
}

function reportPosition() {
  if (!currentUrl || applyingRemote) return;
  const positionMs = Math.round((video.currentTime || 0) * 1000);
  // Throttle
  if (Math.abs(positionMs - lastReportedMs) < 200 && !video.paused) {
    // still send every ~1s via interval
  }
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

video.addEventListener("loadedmetadata", () => {
  setStatus(
    `Stream ready${Number.isFinite(video.duration) ? ` (${Math.round(video.duration / 60)} min)` : ""} — Range streaming`,
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
video.addEventListener("play", () => {
  if (!applyingRemote) reportPosition();
});
video.addEventListener("pause", () => {
  if (!applyingRemote) reportPosition();
});
video.addEventListener("seeked", () => {
  if (!applyingRemote) reportPosition();
});

// Host using controls in this window → push ticks so room stays in sync
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
