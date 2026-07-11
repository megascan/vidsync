/**
 * Content script — bridges VidSync page ↔ extension background.
 * Page talks via window.postMessage; we never expose chrome.* to the page.
 */

const CHANNEL = "vidsync-unblock";
const ALLOWED_ORIGINS = new Set([
  "https://vidsync.ratt.ing",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
]);

// Announce presence early so the page can detect us
try {
  document.documentElement.dataset.vidsyncUnblock = "1";
  document.documentElement.dataset.vidsyncUnblockVersion =
    chrome.runtime.getManifest().version;
} catch {
  // ignore
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;

  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.direction !== "request") return;
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
      eventOrigin(),
    );
  };

  try {
    if (data.type === "ping") {
      const res = await chrome.runtime.sendMessage({ type: "ping" });
      reply({ ok: Boolean(res?.ok), version: res?.version ?? null });
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

function eventOrigin() {
  return window.location.origin;
}

// Also fire a DOM event for listeners that prefer it
try {
  window.dispatchEvent(
    new CustomEvent("vidsync-unblock-ready", {
      detail: { version: chrome.runtime.getManifest().version },
    }),
  );
} catch {
  // ignore
}
