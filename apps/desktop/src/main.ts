import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

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
  | { kind: "error"; code: string; message: string };

// serde may emit camelCase or snake depending on field attrs — handle both
function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (k in obj) return obj[k] as T;
  }
  return undefined;
}

const app = document.querySelector<HTMLDivElement>("#app")!;

let apiBase = "https://api.vidsync.ratt.ing";
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
let port = "8765";
let useUpnp = true;
let busy = false;
let clockOffsetMs = 0;
let applyingRemote = false;
let lastVersion = -1;
let chatDraft = "";

const video = document.createElement("video");
video.playsInline = true;
video.controls = true;
video.style.width = "100%";
video.style.height = "100%";

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
  error = e;
  paint();
}

function applyClock(serverTimeMs: number) {
  clockOffsetMs = serverTimeMs - Date.now();
}

async function applyState(state: PlaybackState, force: boolean) {
  const urlChanged = playback?.videoUrl !== state.videoUrl;
  const ver = state.version;
  playback = state;

  if (!force && ver === lastVersion && !urlChanged) {
    paint();
    return;
  }
  lastVersion = ver;

  const drive = !isHost || force || urlChanged;
  if (drive && state.videoUrl) {
    applyingRemote = true;
    try {
      if (urlChanged || force || video.src !== state.videoUrl) {
        video.src = state.videoUrl;
        video.load();
      }
      const targetSec = expectedPos(state) / 1000;
      if (Number.isFinite(targetSec) && Math.abs((video.currentTime || 0) - targetSec) > 0.4) {
        video.currentTime = targetSec;
      }
      if (state.isPlaying) {
        await video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    } finally {
      queueMicrotask(() => {
        applyingRemote = false;
      });
    }
  }
  paint();
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

// Heartbeat + follower drift
setInterval(() => {
  if (screen !== "room" || !playback?.videoUrl) return;
  if (isHost && playback.isPlaying && !applyingRemote) {
    void invoke("host_heartbeat", {
      positionMs: (video.currentTime || 0) * 1000,
      isPlaying: !video.paused,
    });
  } else if (!isHost && !applyingRemote) {
    const target = expectedPos(playback) / 1000;
    if (Math.abs((video.currentTime || 0) - target) > 0.45) {
      applyingRemote = true;
      video.currentTime = target;
      queueMicrotask(() => {
        applyingRemote = false;
      });
    }
    if (playback.isPlaying && video.paused) void video.play().catch(() => undefined);
    if (!playback.isPlaying && !video.paused) video.pause();
  }
}, 5000);

function normalizeEvent(raw: unknown): SyncEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = (o.kind ?? o.type) as string;
  if (!kind) return null;

  // Rust emits snake_case field names from SyncEvent + camelCase inside nested structs
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
        serverTimeMs: Number(pick(message, "serverTimeMs", "server_time_ms") ?? 0),
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
  return null;
}

async function onSync(raw: unknown) {
  const ev = normalizeEvent(raw);
  if (!ev) return;

  switch (ev.kind) {
    case "connected":
      setStatus("Connected");
      break;
    case "disconnected":
      setError(`Disconnected: ${ev.reason}`);
      break;
    case "welcome":
      sessionId = ev.session_id;
      isHost = ev.is_host;
      members = ev.members;
      applyClock(ev.server_time_ms);
      await applyState(ev.state, true);
      setStatus(isHost ? "You are host" : "Joined as viewer");
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
      setError(`${ev.code}: ${ev.message}`);
      break;
  }
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
    setStatus(`Room ${code}`);
  } catch (e) {
    setError(String(e));
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
    setStatus(`Joined ${code}`);
  } catch (e) {
    setError(String(e));
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
  video.removeAttribute("src");
  video.load();
  setStatus("Left room");
}

async function doStreamFile() {
  if (!isHost || busy) return;
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "webm", "mkv", "mov", "m4v", "avi", "ts"],
      },
    ],
  });
  if (!selected || typeof selected !== "string") return;
  busy = true;
  setStatus("Starting stream…");
  try {
    const info = await invoke<ServeInfo>("stream_start", {
      path: selected,
      port: Number(port) || 8765,
      upnp: useUpnp,
    });
    streamInfo = info;
    const url = info.publicUrl ?? info.lanUrl;
    setStatus(`Streaming ${info.fileName}`);
    await navigator.clipboard.writeText(url).catch(() => undefined);
  } catch (e) {
    setError(String(e));
  } finally {
    busy = false;
    paint();
  }
}

async function doChat() {
  const t = chatDraft.trim();
  if (!t) return;
  chatDraft = "";
  try {
    await invoke("room_chat", { text: t });
  } catch (e) {
    setError(String(e));
  }
  paint();
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(() => setStatus("Copied"));
}

function paint() {
  if (screen === "home") {
    app.innerHTML = `
      <div class="screen home">
        <h1>VidSync</h1>
        <p class="sub">Desktop watch party — lobby, stream, native player. No browser extension.</p>
        <div class="field">
          <label>Nickname</label>
          <input id="nick" value="${escapeAttr(nick)}" ${busy ? "disabled" : ""} />
        </div>
        <div class="field">
          <label>API</label>
          <input id="api" value="${escapeAttr(apiBase)}" ${busy ? "disabled" : ""} />
        </div>
        <button class="primary" id="create" ${busy || !nick.trim() ? "disabled" : ""}>Create room</button>
        <div class="field" style="margin-top:0.5rem">
          <label>Or join</label>
          <div class="row">
            <input id="join" placeholder="ROOMCODE" value="${escapeAttr(joinCode)}" ${busy ? "disabled" : ""} />
            <button id="joinBtn" ${busy || joinCode.trim().length < 6 ? "disabled" : ""}>Join</button>
          </div>
        </div>
        ${status ? `<p class="status">${escapeHtml(status)}</p>` : ""}
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      </div>`;

    app.querySelector<HTMLInputElement>("#nick")!.oninput = (e) => {
      nick = (e.target as HTMLInputElement).value;
    };
    app.querySelector<HTMLInputElement>("#api")!.oninput = (e) => {
      apiBase = (e.target as HTMLInputElement).value;
    };
    app.querySelector<HTMLInputElement>("#join")!.oninput = (e) => {
      joinCode = (e.target as HTMLInputElement).value;
      paint();
    };
    app.querySelector("#create")!.addEventListener("click", () => void doCreate());
    app.querySelector("#joinBtn")!.addEventListener("click", () => void doJoin());
    return;
  }

  // Room
  const url = playback?.videoUrl ?? "";
  app.innerHTML = `
    <div class="screen">
      <header class="room-header">
        <div class="row">
          <h2>${escapeHtml(roomCode)}</h2>
          ${isHost ? `<span class="badge">HOST</span>` : `<span class="muted">viewer</span>`}
        </div>
        <div class="row">
          <button id="copyCode">Copy code</button>
          <button id="leave">Leave</button>
        </div>
      </header>
      <div class="room-body">
        <div class="player-pane">
          <div id="videoMount" style="flex:1;min-height:0;display:flex;background:#000"></div>
          <div class="player-bar">
            ${
              isHost
                ? `
              <button class="primary" id="stream" ${busy ? "disabled" : ""}>Stream local file…</button>
              <label class="muted"><input type="checkbox" id="upnp" ${useUpnp ? "checked" : ""}/> UPnP</label>
              <input id="port" value="${escapeAttr(port)}" style="width:4.5rem" title="Port" />
              <button id="play">Play</button>
              <button id="pause">Pause</button>
            `
                : `<span class="muted">Host controls playback</span>`
            }
            ${status ? `<span class="status">${escapeHtml(status)}</span>` : ""}
            ${error ? `<span class="error">${escapeHtml(error)}</span>` : ""}
          </div>
          ${
            streamInfo
              ? `<div style="padding:0.4rem 0.75rem;background:var(--surface);border-top:1px solid var(--border)">
                  <div class="muted">Stream URL ${streamInfo.upnpMapped ? "(UPnP open)" : "(forward port if remote)"}</div>
                  <div class="mono" id="streamUrl">${escapeHtml(streamInfo.publicUrl ?? streamInfo.lanUrl)}</div>
                  <button id="copyUrl" style="margin-top:0.35rem">Copy URL</button>
                </div>`
              : ""
          }
          ${url ? `<div class="mono" style="padding:0.35rem 0.75rem">Now: ${escapeHtml(url)}</div>` : ""}
        </div>
        <aside class="side">
          <section>
            <h3>In room (${members.length})</h3>
            <ul>
              ${members
                .map(
                  (m) =>
                    `<li>${escapeHtml(m.nickname)}${m.isHost ? " · host" : ""}${
                      m.sessionId === sessionId ? " ★" : ""
                    }</li>`,
                )
                .join("")}
            </ul>
          </section>
          <section>
            <h3>Queue</h3>
            <ul>
              ${(playback?.queue ?? [])
                .map((u, i) => {
                  const active = playback?.queueIndex === i;
                  const short = u.length > 36 ? `${u.slice(0, 36)}…` : u;
                  return `<li class="mono">${active ? "▶ " : "· "}${escapeHtml(short)}</li>`;
                })
                .join("") || `<li class="muted">Empty</li>`}
            </ul>
          </section>
          <section style="flex:1;display:flex;flex-direction:column;min-height:0;border-bottom:none">
            <h3>Chat</h3>
            <div class="chat-log" id="chatLog">
              ${chat
                .map(
                  (c) =>
                    `<div class="line"><span class="nick">${escapeHtml(c.nick)}</span>: ${escapeHtml(c.text)}</div>`,
                )
                .join("") || `<div class="muted">No messages</div>`}
            </div>
            <div class="row" style="margin-top:0.4rem">
              <input id="chat" placeholder="Message…" value="${escapeAttr(chatDraft)}" />
              <button id="send">Send</button>
            </div>
          </section>
        </aside>
      </div>
    </div>`;

  const mount = app.querySelector("#videoMount")!;
  mount.appendChild(video);

  app.querySelector("#copyCode")?.addEventListener("click", () => copy(roomCode));
  app.querySelector("#leave")?.addEventListener("click", () => void doLeave());
  app.querySelector("#stream")?.addEventListener("click", () => void doStreamFile());
  app.querySelector("#upnp")?.addEventListener("change", (e) => {
    useUpnp = (e.target as HTMLInputElement).checked;
  });
  app.querySelector("#port")?.addEventListener("input", (e) => {
    port = (e.target as HTMLInputElement).value;
  });
  app.querySelector("#play")?.addEventListener("click", () => {
    void video.play();
    void invoke("host_play", { positionMs: (video.currentTime || 0) * 1000 });
  });
  app.querySelector("#pause")?.addEventListener("click", () => {
    video.pause();
    void invoke("host_pause", { positionMs: (video.currentTime || 0) * 1000 });
  });
  app.querySelector("#copyUrl")?.addEventListener("click", () => {
    if (streamInfo) copy(streamInfo.publicUrl ?? streamInfo.lanUrl);
  });
  const chatInput = app.querySelector<HTMLInputElement>("#chat");
  chatInput?.addEventListener("input", (e) => {
    chatDraft = (e.target as HTMLInputElement).value;
  });
  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doChat();
  });
  app.querySelector("#send")?.addEventListener("click", () => void doChat());

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
  wireVideoHostEvents();
  try {
    apiBase = await invoke<string>("default_api");
  } catch {
    /* use default */
  }
  await listen("sync-event", (e) => {
    void onSync(e.payload);
  });
  paint();
}

void boot();
