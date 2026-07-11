/**
 * VidSync Unblock — service worker
 *
 * Room tab = lobby (queue/chat/WS). Extension player = media + host controls
 * (chrome-extension page + host_permissions → Range streaming, no page CORS).
 * Host play/pause/seek in player → room tab → DO.
 */

const ALLOWED_PAGE_ORIGINS = new Set([
  "https://vidsync.ratt.ing",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
]);

/** @type {number | null} */
let playerTabId = null;
/** @type {number | null} */
let roomTabId = null;

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function isHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isExtensionPage(sender) {
  return Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
}

function senderAllowed(sender) {
  if (isExtensionPage(sender)) return true;
  if (sender.id != null && sender.id !== chrome.runtime.id) return false;
  const pageUrl = sender.url ?? sender.origin ?? null;
  if (!pageUrl) return false;
  try {
    const origin = pageUrl.includes("://")
      ? new URL(pageUrl).origin
      : pageUrl;
    return ALLOWED_PAGE_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

function buildHeaders(headers) {
  const h = new Headers();
  if (!headers) return h;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    const key = k.toLowerCase();
    if (key === "cookie" || key === "authorization" || key === "cookie2")
      continue;
    try {
      h.set(k, v);
    } catch {
      /* */
    }
  }
  return h;
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function setTabBadge(tabId, active) {
  if (tabId == null) return;
  try {
    if (active) {
      await chrome.action.setBadgeText({ tabId, text: "ON" });
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: "#34d399",
      });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
    }
  } catch {
    /* */
  }
}

/**
 * @param {string} url
 * @param {object | null} state
 * @param {number | undefined} fromTabId
 */
async function openPlayer(url, state, fromTabId) {
  if (fromTabId != null) roomTabId = fromTabId;

  const playerPath = chrome.runtime.getURL(
    `player.html?url=${encodeURIComponent(url)}`,
  );

  if (playerTabId != null) {
    try {
      await chrome.tabs.get(playerTabId);
      await chrome.tabs.update(playerTabId, { active: true, url: playerPath });
      schedulePlayerLoad(url, state);
      return { ok: true, tabId: playerTabId, reused: true };
    } catch {
      playerTabId = null;
    }
  }

  const win = await chrome.windows.create({
    url: playerPath,
    type: "popup",
    width: 960,
    height: 600,
    focused: true,
  });
  const tab = win.tabs?.[0];
  playerTabId = tab?.id ?? null;
  schedulePlayerLoad(url, state);
  return { ok: true, tabId: playerTabId, reused: false, popup: true };
}

function schedulePlayerLoad(url, state) {
  const trySend = (attempt) => {
    if (playerTabId == null) return;
    void chrome.tabs
      .sendMessage(playerTabId, {
        type: "player_load",
        url,
        state: state ?? null,
      })
      .catch(() => {
        if (attempt < 8) {
          setTimeout(() => trySend(attempt + 1), 250);
        }
      });
  };
  setTimeout(() => trySend(0), 300);
}

async function relayToPlayer(message) {
  if (playerTabId == null) return { ok: false, error: "no_player" };
  try {
    await chrome.tabs.get(playerTabId);
    const res = await chrome.tabs.sendMessage(playerTabId, message);
    return res ?? { ok: true };
  } catch {
    playerTabId = null;
    return { ok: false, error: "player_gone" };
  }
}

function postToRoomTab(payload) {
  if (roomTabId == null) return;
  void chrome.tabs
    .sendMessage(roomTabId, {
      type: "room_from_player",
      ...payload,
    })
    .catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === playerTabId) playerTabId = null;
  if (tabId === roomTabId) roomTabId = null;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "bad_message" });
    return false;
  }

  if (message.type === "player_ready") {
    if (sender.tab?.id != null) playerTabId = sender.tab.id;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "player_tick") {
    postToRoomTab({
      event: "tick",
      positionMs: message.positionMs,
      isPlaying: message.isPlaying,
      durationMs: message.durationMs,
      videoUrl: message.videoUrl,
    });
    sendResponse({ ok: true });
    return false;
  }

  // Host used native controls in player window → room applies to DO if host
  if (message.type === "player_user_control") {
    postToRoomTab({
      event: "user_control",
      controlType: message.controlType,
      positionMs: message.positionMs,
      isPlaying: message.isPlaying,
      videoUrl: message.videoUrl,
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "tab_active") {
    void setTabBadge(sender.tab?.id, Boolean(message.active));
    sendResponse({ ok: true });
    return false;
  }

  if (!senderAllowed(sender)) {
    sendResponse({ ok: false, error: "forbidden_sender" });
    return false;
  }

  if (message.type === "ping") {
    void setTabBadge(sender.tab?.id, true);
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      player: true,
      stream: true,
      mode: "extension_player",
    });
    return false;
  }

  if (message.type === "open_player") {
    if (!isHttpUrl(message.url)) {
      sendResponse({ ok: false, error: "invalid_url" });
      return false;
    }
    void openPlayer(message.url, message.state ?? null, sender.tab?.id)
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: "open_failed",
          message: e instanceof Error ? e.message : "open failed",
        }),
      );
    return true;
  }

  if (message.type === "player_state") {
    void relayToPlayer({
      type: "player_state",
      state: message.state,
    }).then(sendResponse);
    return true;
  }

  if (message.type === "player_control") {
    void relayToPlayer({
      type: "player_control",
      controlType: message.controlType,
      positionMs: message.positionMs,
      isPlaying: message.isPlaying,
    }).then(sendResponse);
    return true;
  }

  if (message.type === "close_player") {
    if (playerTabId != null) {
      void chrome.tabs.remove(playerTabId).catch(() => {});
      playerTabId = null;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "fetch") {
    void handleFetch(message, sendResponse);
    return true;
  }

  if (message.type === "enable_cors") {
    sendResponse({ ok: true, mode: "extension_player" });
    return false;
  }

  sendResponse({ ok: false, error: "unknown_type" });
  return false;
});

async function handleFetch(message, sendResponse) {
  try {
    const url = message.url;
    if (!isHttpUrl(url)) {
      sendResponse({ ok: false, error: "invalid_url" });
      return;
    }
    const method = message.method === "HEAD" ? "HEAD" : "GET";
    const headers = buildHeaders(message.headers);
    const hasRange = headers.has("Range") || headers.has("range");

    const res = await fetch(url, {
      method,
      headers,
      redirect: "follow",
      credentials: "omit",
      cache: "no-store",
    });

    /** @type {Record<string, string>} */
    const outHeaders = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });

    if (method === "HEAD" || message.responseType === "headers-only") {
      sendResponse({
        ok: true,
        status: res.status,
        headers: outHeaders,
        bodyBase64: null,
      });
      return;
    }

    const lenHeader = res.headers.get("content-length");
    if (!hasRange && lenHeader) {
      const n = Number(lenHeader);
      if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
        sendResponse({
          ok: false,
          error: "use_extension_player",
          message: "Large file — use Stream with Unblock (extension player).",
        });
        return;
      }
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      sendResponse({ ok: false, error: "body_too_large" });
      return;
    }

    sendResponse({
      ok: true,
      status: res.status,
      headers: outHeaders,
      bodyBase64: bufferToBase64(buf),
      byteLength: buf.byteLength,
    });
  } catch (e) {
    sendResponse({
      ok: false,
      error: "fetch_failed",
      message: e instanceof Error ? e.message : "fetch failed",
    });
  }
}
