/**
 * VidSync Unblock — service worker
 *
 * 1) declarativeNetRequest: add CORS headers on media/XHR responses
 *    initiated by VidSync pages (so <video> / hls.js work in-page).
 * 2) Message fetch: content script can pull bytes when DNR isn't enough.
 */

const ALLOWED_PAGE_ORIGINS = new Set([
  "https://vidsync.ratt.ing",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
]);

const CORS_RULE_ID = 1;
const MAX_BODY_BYTES = 80 * 1024 * 1024;

function isHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function senderAllowed(sender) {
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
    if (key === "cookie" || key === "authorization" || key === "cookie2") continue;
    try {
      h.set(k, v);
    } catch {
      /* invalid */
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

async function ensureCorsRules() {
  const rule = {
    id: CORS_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        {
          header: "Access-Control-Allow-Origin",
          operation: "set",
          value: "*",
        },
        {
          header: "Access-Control-Allow-Methods",
          operation: "set",
          value: "GET, HEAD, OPTIONS",
        },
        {
          header: "Access-Control-Allow-Headers",
          operation: "set",
          value: "*",
        },
        {
          header: "Access-Control-Expose-Headers",
          operation: "set",
          value: "*, Content-Length, Content-Range, Accept-Ranges, Content-Type",
        },
        {
          header: "Access-Control-Allow-Credentials",
          operation: "set",
          value: "true",
        },
      ],
    },
    condition: {
      // Only rewrite responses for requests that VidSync initiated
      initiatorDomains: ["vidsync.ratt.ing", "localhost", "127.0.0.1"],
      resourceTypes: [
        "xmlhttprequest",
        "media",
        "other",
        "image",
        "font",
      ],
    },
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [CORS_RULE_ID],
    addRules: [rule],
  });
  return true;
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
      await chrome.action.setTitle({
        tabId,
        title: "VidSync Unblock — active on this tab",
      });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({ tabId, title: "VidSync Unblock" });
    }
  } catch {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureCorsRules();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureCorsRules();
});

// Session rules die when browser restarts — re-apply when SW wakes
void ensureCorsRules();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "tab_active") {
    void setTabBadge(sender.tab?.id, Boolean(message.active));
    void ensureCorsRules();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "enable_cors") {
    void ensureCorsRules()
      .then(() => sendResponse({ ok: true, cors: true }))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: "cors_rules_failed",
          message: e instanceof Error ? e.message : "rules failed",
        }),
      );
    return true;
  }

  if (!senderAllowed(sender)) {
    sendResponse({ ok: false, error: "forbidden_sender" });
    return false;
  }

  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "bad_message" });
    return false;
  }

  if (message.type === "ping") {
    void setTabBadge(sender.tab?.id, true);
    void ensureCorsRules();
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      cors: true,
    });
    return false;
  }

  if (message.type === "fetch") {
    void handleFetch(message, sendResponse);
    return true;
  }

  sendResponse({ ok: false, error: "unknown_type" });
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  const url = tab.url ?? "";
  const onVid =
    url.startsWith("https://vidsync.ratt.ing") ||
    url.startsWith("http://localhost:4321") ||
    url.startsWith("http://127.0.0.1:4321");
  void setTabBadge(tabId, onVid);
  if (onVid) void ensureCorsRules();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void chrome.tabs.get(activeInfo.tabId).then((tab) => {
    const url = tab.url ?? "";
    const onVid =
      url.startsWith("https://vidsync.ratt.ing") ||
      url.startsWith("http://localhost:4321") ||
      url.startsWith("http://127.0.0.1:4321");
    void setTabBadge(activeInfo.tabId, onVid);
  });
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
          message: `File is ~${Math.round(n / 1024 / 1024)}MB — skip full download. Use CORS shim + normal/Range play (Open with Unblock does that for progressive). HLS segments stay small.`,
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
