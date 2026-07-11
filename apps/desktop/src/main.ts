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
  | { kind: "error"; code: string; message: string }
  | { kind: "room_closed"; reason: string; message: string };

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (k in obj) return obj[k] as T;
  }
  return undefined;
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
let screen: "home" | "room" = "home";
let joinCode = "";
let busy = false;
let clockOffsetMs = 0;
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
// Helps WebKit avoid some opaque cross-origin range edge cases
video.crossOrigin = "anonymous";

function nowServer(): number {
  return Date.now() + clockOffsetMs;
}

function expectedPos(state: PlaybackState): number {
  if (!state.isPlaying) return state.positionMs;
  return Math.max(0, state.positionMs + (nowServer() - state.serverAnchorMs));
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

function applyClock(serverTimeMs: number) {
  clockOffsetMs = serverTimeMs - Date.now();
}

function hasMedia(): boolean {
  return Boolean(playback?.videoUrl);
}

async function applyState(state: PlaybackState, force: boolean) {
  const gen = ++applyGen;
  const prevUrl = playback?.videoUrl ?? null;
  const urlChanged = prevUrl !== state.videoUrl;
  const ver = state.version;
  playback = state;

  if (!force && ver === lastVersion && !urlChanged) {
    paint();
    return;
  }
  lastVersion = ver;

  // Host owns the element for local open; still apply URL changes from set_url/queue
  const drive = !isHost || force || urlChanged;
  if (drive && state.videoUrl) {
    applyingRemote = true;
    try {
      // Mount before load — WebKitGTK is flaky decoding fully detached <video>
      ensureVideoMounted();
      const needLoad =
        urlChanged ||
        force ||
        !video.src ||
        !video.src.includes(tokenFromUrl(state.videoUrl));
      if (needLoad) {
        await loadVideoSrc(state.videoUrl);
        if (gen !== applyGen) return;
      }
      const targetSec = expectedPos(state) / 1000;
      await safeSeek(targetSec, gen);
      if (gen !== applyGen) return;
      if (state.isPlaying) {
        await safePlay();
      } else {
        try {
          video.pause();
        } catch {
          /* WebKit */
        }
      }
    } catch (e) {
      console.warn("applyState media failed", e);
      // Don't kill the room UI — show soft error
      if (gen === applyGen) {
        error = "Couldn't load the host stream (codec, network, or firewall)";
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
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch {
      /* */
    }
    applyingRemote = false;
  }
  if (gen === applyGen) paint();
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

/** Put video in the room shell if it exists (no-op on home). */
function ensureVideoMounted() {
  const mount = app.querySelector("#videoMount");
  if (!mount) return;
  mount.querySelector(".video-empty")?.remove();
  if (video.parentElement !== mount) {
    mount.appendChild(video);
  }
}

/**
 * Hard-reset media element. Always detach-safe: never leave WebKit mid-decode
 * under a parent about to be wiped by paint().
 */
async function loadVideoSrc(url: string): Promise<void> {
  try {
    video.pause();
  } catch {
    /* */
  }
  // Clear previous resource fully before assigning a new host URL
  video.removeAttribute("src");
  while (video.firstChild) video.removeChild(video.firstChild);
  video.load();

  video.preload = "auto";
  video.src = url;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", done);
      video.removeEventListener("loadeddata", done);
      resolve();
    };
    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("error", done, { once: true });
    window.setTimeout(done, 8000);
  });
}

/** Seek only when WebKit is ready — seeking too early crashes some Linux builds. */
async function safeSeek(targetSec: number, gen: number): Promise<void> {
  if (!Number.isFinite(targetSec) || targetSec < 0) return;
  if (video.readyState < 1) return; // HAVE_NOTHING
  if (Math.abs((video.currentTime || 0) - targetSec) <= 0.4) return;

  // Prefer a time within seekable ranges when available
  let t = targetSec;
  try {
    if (video.seekable && video.seekable.length > 0) {
      const start = video.seekable.start(0);
      const end = video.seekable.end(video.seekable.length - 1);
      t = Math.min(Math.max(targetSec, start), end);
    }
  } catch {
    /* seekable not ready */
  }

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
    window.setTimeout(done, 2500);
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

// Host keepalive every 5s while in room (playing OR paused). Server uses this
// as proof of life — room only dies after HOST_STALE_MS without host packets.
setInterval(() => {
  if (screen !== "room") return;

  if (isHost && !applyingRemote) {
    void invoke("host_heartbeat", {
      positionMs: (video.currentTime || 0) * 1000,
      isPlaying: playback?.videoUrl ? !video.paused : false,
    });
    return;
  }

  if (!isHost && playback?.videoUrl && !applyingRemote) {
    const target = expectedPos(playback) / 1000;
    if (Math.abs((video.currentTime || 0) - target) > 0.45) {
      applyingRemote = true;
      video.currentTime = target;
      queueMicrotask(() => {
        applyingRemote = false;
      });
    }
    if (playback.isPlaying && video.paused)
      void video.play().catch(() => undefined);
    if (!playback.isPlaying && !video.paused) video.pause();
  }
}, 5000);

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
      members: (pick(o, "members") as Member[]) ?? [],
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
    return { kind: "members", members: (pick(o, "members") as Member[]) ?? [] };
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
      status = "";
      break;
    case "disconnected":
      setError("Connection lost");
      break;
    case "welcome":
      sessionId = ev.session_id;
      isHost = ev.is_host;
      members = ev.members;
      applyClock(ev.server_time_ms);
      // Switch shell first so <video> has a live mount before we load media.
      // Join-while-playing used to load then paint() and WebKitGTK often died.
      screen = "room";
      status = "";
      error = "";
      paint();
      await applyState(ev.state, true);
      break;
    case "state":
      applyClock(ev.server_time_ms);
      await applyState(ev.state, false);
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
  roomCode = "";
  isHost = false;
  sessionId = "";
  members = [];
  playback = null;
  chat = [];
  streamInfo = null;
  video.removeAttribute("src");
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
    screen = "room";
    status = "";
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
    screen = "room";
    status = "";
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
  roomCode = "";
  isHost = false;
  sessionId = "";
  members = [];
  playback = null;
  chat = [];
  streamInfo = null;
  status = "";
  error = "";
  video.removeAttribute("src");
  video.load();
  paint();
}

async function pickVideoFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "webm", "mkv", "mov", "m4v", "avi", "ts"],
      },
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
  setStatus("Opening video…");
  try {
    const info = await invoke<ServeInfo>("stream_start", {
      path,
      port: STREAM_PORT,
      upnp: USE_UPNP,
    });
    streamInfo = info;
    // Local play immediately (state event follows)
    applyingRemote = true;
    try {
      await loadVideoSrc(info.publicUrl ?? info.lanUrl);
      await video.play().catch(() => undefined);
    } finally {
      applyingRemote = false;
    }
    toast(info.fileName);
  } catch (e) {
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
  setStatus("Adding…");
  try {
    const info = await invoke<ServeInfo>("queue_add_file", { path });
    streamInfo = info;
    toast(`Queued ${info.fileName}`);
  } catch (e) {
    setError(friendlyErr(e));
  } finally {
    busy = false;
    paint();
  }
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
    if (!(el instanceof HTMLInputElement)) return;
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

function paint() {
  if (screen === "home") {
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
            ${flash}
          </div>
        </div>
      </div>`;
    return;
  }

  const media = hasMedia();
  const fileLabel = streamInfo?.fileName ?? "";
  const emptyCopy = isHost
    ? {
        title: "Nothing playing",
        body: "Open a video file to start the room.",
      }
    : {
        title: "Waiting for host",
        body: "Video shows up here when they start streaming.",
      };

  const flashBar = error
    ? `<span class="bar-meta err">${escapeHtml(error)}</span>`
    : status
      ? `<span class="bar-meta">${escapeHtml(status)}</span>`
      : "";

  // CRITICAL: detach <video> before thrashing innerHTML. WebKitGTK crashes when a
  // playing/loading media element is destroyed as a descendant of replaced markup
  // (common path: guest joins while host already has media).
  if (video.parentNode) {
    video.remove();
  }

  app.innerHTML = `
    <div class="screen">
      ${updateBannerHtml()}
      <header class="room-header">
        <div class="room-id">
          <code>${escapeHtml(roomCode)}</code>
          <span class="pill ${isHost ? "host" : "viewer"}">${isHost ? "Host" : "Watching"}</span>
        </div>
        <div class="header-actions">
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
              <button type="button" class="primary" id="stream" ${busy ? "disabled" : ""}>Play file…</button>
              <button type="button" id="queueAdd" ${busy ? "disabled" : ""}>Add to queue</button>
              <button type="button" id="play" ${!media || busy ? "disabled" : ""}>Play</button>
              <button type="button" id="pause" ${!media || busy ? "disabled" : ""}>Pause</button>
            `
                : `<span class="bar-meta">${media ? "Synced to host" : "Waiting…"}</span>`
            }
            <span class="spacer"></span>
            ${flashBar}
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
            <p class="panel-title">People · ${members.length}</p>
            <ul class="people">
              ${
                members
                  .map((m) => {
                    const you = m.sessionId === sessionId;
                    return `<li>
                      <span class="${you ? "you" : ""}">${escapeHtml(m.nickname)}${you ? " (you)" : ""}</span>
                      ${m.isHost ? `<span class="tag">host</span>` : ""}
                    </li>`;
                  })
                  .join("") || `<li class="empty">…</li>`
              }
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
                `<li class="empty" style="color:var(--faint)">${isHost ? "Add videos with Play file or Add to queue" : "Empty"}</li>`
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

  const mount = app.querySelector("#videoMount");
  if (mount && media) {
    ensureVideoMounted();
  }
  // if !media, video stays detached (already removed above)

  const log = app.querySelector("#chatLog");
  if (log) log.scrollTop = log.scrollHeight;
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
  paint();
  // Non-blocking; banner paints when update found
  void checkForUpdates();
}

void boot();
