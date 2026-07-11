/**
 * Content script on VidSync pages — bridges room page ↔ background ↔ player popup.
 */

const CHANNEL = "vidsync-unblock";
const ALLOWED_ORIGINS = new Set([
  "https://vidsync.ratt.ing",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
]);

const VERSION = chrome.runtime.getManifest().version;

function markDom() {
  try {
    document.documentElement.dataset.vidsyncUnblock = "1";
    document.documentElement.dataset.vidsyncUnblockVersion = VERSION;
  } catch {
    /* */
  }
}

function injectMainWorldFlag() {
  try {
    const script = document.createElement("script");
    script.textContent = `(function(){
      try {
        window.__VIDSYNC_UNBLOCK__ = {
          version: ${JSON.stringify(VERSION)},
          ready: true,
          mode: "extension_player",
          channel: ${JSON.stringify(CHANNEL)}
        };
        document.documentElement.dataset.vidsyncUnblock = "1";
        document.documentElement.dataset.vidsyncUnblockVersion = ${JSON.stringify(VERSION)};
        window.dispatchEvent(new CustomEvent("vidsync-unblock-ready", {
          detail: window.__VIDSYNC_UNBLOCK__
        }));
      } catch (e) {}
    })();`;
    (document.documentElement || document).appendChild(script);
    script.remove();
  } catch {
    /* */
  }
}

function announce() {
  markDom();
  injectMainWorldFlag();
  try {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "event",
        type: "ready",
        version: VERSION,
        ok: true,
        mode: "extension_player",
      },
      window.location.origin,
    );
  } catch {
    /* */
  }
}

announce();
[0, 100, 500, 1500].forEach((ms) => setTimeout(announce, ms));

// Background → content → page (player ticks)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "room_from_player") {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "event",
        type: "player_tick",
        positionMs: message.positionMs,
        isPlaying: message.isPlaying,
        durationMs: message.durationMs,
        videoUrl: message.videoUrl,
      },
      window.location.origin,
    );
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;
  if (data.direction === "response" || data.direction === "event") return;
  if (data.direction !== "request") return;
  if (typeof data.id !== "string" || typeof data.type !== "string") return;
  void handlePageRequest(data);
});

/**
 * @param {{ id: string, type: string, payload?: Record<string, unknown> }} data
 */
async function handlePageRequest(data) {
  const reply = (payload) => {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "response",
        id: data.id,
        ...payload,
      },
      window.location.origin,
    );
  };

  try {
    if (data.type === "ping") {
      try {
        const res = await chrome.runtime.sendMessage({ type: "ping" });
        reply({
          ok: true,
          version: res?.version ?? VERSION,
          mode: res?.mode ?? "extension_player",
        });
      } catch {
        reply({ ok: true, version: VERSION, mode: "extension_player" });
      }
      return;
    }

    if (data.type === "open_player") {
      const payload = data.payload ?? {};
      const res = await chrome.runtime.sendMessage({
        type: "open_player",
        url: payload.url,
        state: payload.state ?? null,
      });
      reply(res ?? { ok: false, error: "no_response" });
      return;
    }

    if (data.type === "player_state") {
      const res = await chrome.runtime.sendMessage({
        type: "player_state",
        state: data.payload?.state ?? data.payload,
      });
      reply(res ?? { ok: false });
      return;
    }

    if (data.type === "player_control") {
      const res = await chrome.runtime.sendMessage({
        type: "player_control",
        controlType: data.payload?.controlType,
        positionMs: data.payload?.positionMs,
        isPlaying: data.payload?.isPlaying,
      });
      reply(res ?? { ok: false });
      return;
    }

    if (data.type === "close_player") {
      const res = await chrome.runtime.sendMessage({ type: "close_player" });
      reply(res ?? { ok: true });
      return;
    }

    if (data.type === "enable_cors") {
      reply({ ok: true, mode: "extension_player" });
      return;
    }

    if (data.type === "fetch") {
      const payload = data.payload ?? {};
      const res = await chrome.runtime.sendMessage({
        type: "fetch",
        url: payload.url,
        method: payload.method,
        headers: payload.headers,
        responseType: payload.responseType,
      });
      reply(res ?? { ok: false, error: "no_response" });
      return;
    }

    reply({ ok: false, error: "unknown_type" });
  } catch (e) {
    reply({
      ok: false,
      error: "bridge_error",
      message: e instanceof Error ? e.message : "bridge error",
    });
  }
}

try {
  chrome.runtime.sendMessage({ type: "tab_active", active: true }).catch(() => {});
} catch {
  /* */
}
