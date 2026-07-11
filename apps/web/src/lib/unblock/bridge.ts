const CHANNEL = "vidsync-unblock";

export type UnblockFetchResult = {
  ok: true;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string | null;
  byteLength?: number;
};

export type UnblockFetchError = {
  ok: false;
  error: string;
  message?: string;
  status?: number;
  headers?: Record<string, string>;
};

export type UnblockFetchResponse = UnblockFetchResult | UnblockFetchError;

type Pending = {
  resolve: (
    v: UnblockFetchResponse | { ok: true; version: string | null },
  ) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
let listening = false;

declare global {
  interface Window {
    __VIDSYNC_UNBLOCK__?: {
      version?: string;
      ready?: boolean;
      channel?: string;
    };
  }
}

function ensureListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as {
      channel?: string;
      direction?: string;
      id?: string;
      type?: string;
      version?: string;
      ok?: boolean;
      [key: string]: unknown;
    } | null;
    if (!data || data.channel !== CHANNEL) return;

    // Extension ready broadcast (no id)
    if (data.direction === "event" && data.type === "ready") {
      window.dispatchEvent(
        new CustomEvent("vidsync-unblock-ready", {
          detail: { version: data.version ?? null, ready: true },
        }),
      );
      return;
    }

    if (data.direction !== "response") return;
    if (typeof data.id !== "string") return;
    const p = pending.get(data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(data.id);
    p.resolve(
      data as UnblockFetchResponse | { ok: true; version: string | null },
    );
  });
}

function requestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pageRequest(
  type: string,
  payload?: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<UnblockFetchResponse | { ok: true; version: string | null }> {
  ensureListener();
  return new Promise((resolve, reject) => {
    const id = requestId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("VidSync Unblock timed out — is the extension loaded?"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "request",
        id,
        type,
        payload,
      },
      window.location.origin,
    );
  });
}

/** True if content script marked the page or MAIN-world flag is set. */
export function isUnblockInstalled(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  if (window.__VIDSYNC_UNBLOCK__?.ready) return true;
  return document.documentElement.dataset.vidsyncUnblock === "1";
}

export function getUnblockVersion(): string | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  return (
    window.__VIDSYNC_UNBLOCK__?.version ??
    document.documentElement.dataset.vidsyncUnblockVersion ??
    null
  );
}

/**
 * Always tries postMessage ping (even if dataset not set yet).
 * Content script can answer without the SW if needed.
 */
export async function pingUnblock(): Promise<{
  ok: boolean;
  version: string | null;
}> {
  if (typeof window === "undefined") return { ok: false, version: null };
  ensureListener();
  try {
    const res = await pageRequest("ping", undefined, 2500);
    const ok = Boolean(res && "ok" in res && res.ok);
    const version =
      res && "version" in res && typeof res.version === "string"
        ? res.version
        : getUnblockVersion();
    return { ok, version };
  } catch {
    // Fall back to passive markers
    if (isUnblockInstalled()) {
      return { ok: true, version: getUnblockVersion() };
    }
    return { ok: false, version: null };
  }
}

/** Ensure DNR CORS shim is registered (session rules). */
export async function enableUnblockCors(): Promise<{
  ok: boolean;
  message?: string;
}> {
  if (typeof window === "undefined") return { ok: false, message: "no window" };
  ensureListener();
  try {
    const res = (await pageRequest("enable_cors", undefined, 5000)) as {
      ok?: boolean;
      message?: string;
      error?: string;
    };
    return {
      ok: Boolean(res?.ok),
      message: res?.message ?? res?.error,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "enable_cors timeout",
    };
  }
}

export async function unblockFetch(
  url: string,
  opts?: {
    method?: "GET" | "HEAD";
    headers?: Record<string, string>;
    responseType?: "arraybuffer" | "headers-only";
    timeoutMs?: number;
  },
): Promise<UnblockFetchResponse> {
  try {
    const res = await pageRequest(
      "fetch",
      {
        url,
        method: opts?.method ?? "GET",
        headers: opts?.headers,
        responseType: opts?.responseType,
      },
      opts?.timeoutMs ?? 120_000,
    );
    return res as UnblockFetchResponse;
  } catch (e) {
    return {
      ok: false,
      error: "bridge_timeout",
      message: e instanceof Error ? e.message : "bridge timeout",
    };
  }
}

/** Cache-bust so the player re-requests after DNR rules apply. */
export function withUnblockCacheBust(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_vu", String(Date.now()));
    return u.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}_vu=${Date.now()}`;
  }
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function base64ToBlob(
  b64: string,
  contentType = "application/octet-stream",
): Blob {
  return new Blob([base64ToArrayBuffer(b64)], { type: contentType });
}

/** Subscribe when extension becomes ready; also polls for a few seconds. */
export function onUnblockReady(
  cb: (version: string | null) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  let stopped = false;
  const fire = (v: string | null) => {
    if (!stopped) cb(v);
  };

  if (isUnblockInstalled()) {
    fire(getUnblockVersion());
  }

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ version?: string }>).detail;
    fire(detail?.version ?? getUnblockVersion());
  };
  window.addEventListener("vidsync-unblock-ready", handler);

  // Aggressive poll — content script re-announces; SPA hydration races
  const intervals = [50, 150, 400, 1000, 2000, 4000].map((ms) =>
    window.setTimeout(() => {
      void pingUnblock().then((r) => {
        if (r.ok) fire(r.version);
      });
    }, ms),
  );

  return () => {
    stopped = true;
    window.removeEventListener("vidsync-unblock-ready", handler);
    for (const t of intervals) window.clearTimeout(t);
  };
}
