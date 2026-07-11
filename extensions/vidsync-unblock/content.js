/**
 * Content script — bridges VidSync page ↔ extension background.
 *
 * Note: Chrome will NOT auto-open the toolbar popup when you land on the site
 * (browser security). Interaction is: this bridge + in-page UI on VidSync.
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
    const el = document.documentElement;
    if (!el) return;
    el.dataset.vidsyncUnblock = "1";
    el.dataset.vidsyncUnblockVersion = VERSION;
  } catch {
    // ignore
  }
}

/** MAIN-world flag so the page always sees us (dataset can race with frameworks). */
function injectMainWorldFlag() {
  try {
    const script = document.createElement("script");
    script.textContent = `(function(){
      try {
        window.__VIDSYNC_UNBLOCK__ = {
          version: ${JSON.stringify(VERSION)},
          ready: true,
          channel: ${JSON.stringify(CHANNEL)}
        };
        document.documentElement.dataset.vidsyncUnblock = "1";
        document.documentElement.dataset.vidsyncUnblockVersion = ${JSON.stringify(VERSION)};
        window.dispatchEvent(new CustomEvent("vidsync-unblock-ready", {
          detail: window.__VIDSYNC_UNBLOCK__
        }));
      } catch (e) {}
    })();`;
    const root = document.documentElement || document.head || document;
    root.appendChild(script);
    script.remove();
  } catch {
    // ignore
  }
}

function announce() {
  markDom();
  injectMainWorldFlag();
  try {
    window.dispatchEvent(
      new CustomEvent("vidsync-unblock-ready", {
        detail: { version: VERSION, ready: true },
      }),
    );
  } catch {
    // ignore
  }
  // Tell the page via postMessage too (some listeners only use that)
  try {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "event",
        type: "ready",
        version: VERSION,
        ok: true,
      },
      window.location.origin,
    );
  } catch {
    // ignore
  }
}

announce();
// SPA / late hydration — re-announce a few times
[0, 100, 500, 1500, 3000].forEach((ms) => {
  setTimeout(announce, ms);
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;

  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;

  // Ignore our own events/responses
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
      // Prefer local answer so we still work if SW is asleep
      try {
        const res = await chrome.runtime.sendMessage({ type: "ping" });
        reply({
          ok: true,
          version: res?.version ?? VERSION,
          bridge: "content+background",
        });
      } catch {
        reply({ ok: true, version: VERSION, bridge: "content-only" });
      }
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

// Badge the toolbar icon while on VidSync (popup still user-click only)
try {
  chrome.runtime.sendMessage({ type: "tab_active", active: true }).catch(() => {});
} catch {
  // ignore
}
