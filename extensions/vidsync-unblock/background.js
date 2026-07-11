/**
 * VidSync Unblock — service worker
 * Fetches media with extension host permissions (no page CORS).
 * Only answers messages from our content script on allowlisted VidSync origins.
 */

const ALLOWED_PAGE_ORIGINS = new Set([
  "https://vidsync.ratt.ing",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
]);

const MAX_BODY_BYTES = 80 * 1024 * 1024; // 80 MiB hard cap for full-buffer path

/**
 * @param {string | undefined} url
 */
function isHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {chrome.runtime.MessageSender} sender
 */
function senderAllowed(sender) {
  // Content scripts: sender.id is this extension; url/origin is the page
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

/**
 * @param {Record<string, string> | undefined} headers
 * @returns {Headers}
 */
function buildHeaders(headers) {
  const h = new Headers();
  if (!headers) return h;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    const key = k.toLowerCase();
    // Never forward cookie/auth from the page into arbitrary origins
    if (key === "cookie" || key === "authorization" || key === "cookie2") continue;
    try {
      h.set(k, v);
    } catch {
      // invalid header name
    }
  }
  return h;
}

/**
 * @param {ArrayBuffer} buf
 */
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!senderAllowed(sender)) {
    sendResponse({ ok: false, error: "forbidden_sender" });
    return false;
  }

  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "bad_message" });
    return false;
  }

  if (message.type === "ping") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  if (message.type === "fetch") {
    void handleFetch(message, sendResponse);
    return true; // async
  }

  sendResponse({ ok: false, error: "unknown_type" });
  return false;
});

/**
 * @param {{ url: string, method?: string, headers?: Record<string, string>, responseType?: string }} message
 * @param {(r: unknown) => void} sendResponse
 */
async function handleFetch(message, sendResponse) {
  try {
    const url = message.url;
    if (!isHttpUrl(url)) {
      sendResponse({ ok: false, error: "invalid_url" });
      return;
    }

    const method = message.method === "HEAD" ? "HEAD" : "GET";
    const headers = buildHeaders(message.headers);

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
    if (lenHeader) {
      const n = Number(lenHeader);
      if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
        sendResponse({
          ok: false,
          error: "body_too_large",
          status: res.status,
          headers: outHeaders,
          message: `Body larger than ${MAX_BODY_BYTES} bytes; use Range/HLS segments`,
        });
        return;
      }
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      sendResponse({
        ok: false,
        error: "body_too_large",
        status: res.status,
        headers: outHeaders,
      });
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
