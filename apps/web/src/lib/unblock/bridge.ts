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
  resolve: (v: UnblockFetchResponse | { ok: true; version: string | null }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
let listening = false;

function ensureListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as {
      channel?: string;
      direction?: string;
      id?: string;
      ok?: boolean;
      [key: string]: unknown;
    } | null;
    if (!data || data.channel !== CHANNEL || data.direction !== "response") return;
    if (typeof data.id !== "string") return;
    const p = pending.get(data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(data.id);
    p.resolve(data as UnblockFetchResponse | { ok: true; version: string | null });
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
      reject(new Error("VidSync Unblock timed out"));
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

/** True if content script marked the page (extension installed + allowed origin). */
export function isUnblockInstalled(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.vidsyncUnblock === "1";
}

export function getUnblockVersion(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement.dataset.vidsyncUnblockVersion ?? null;
}

export async function pingUnblock(): Promise<{
  ok: boolean;
  version: string | null;
}> {
  if (!isUnblockInstalled()) return { ok: false, version: null };
  try {
    const res = await requestIdPing();
    return {
      ok: Boolean(res && "ok" in res && res.ok),
      version:
        res && "version" in res && typeof res.version === "string"
          ? res.version
          : getUnblockVersion(),
    };
  } catch {
    return { ok: false, version: null };
  }
}

async function requestIdPing() {
  return requestRequest("ping", undefined, 5000);
}

async function requestRequest(
  type: string,
  payload?: Record<string, unknown>,
  timeoutMs?: number,
) {
  return pageRequest(type, payload, timeoutMs);
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
  if (!isUnblockInstalled()) {
    return { ok: false, error: "not_installed" };
  }
  const res = await requestRequest(
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

/** Subscribe when extension injects late (rare). */
export function onUnblockReady(cb: (version: string | null) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (isUnblockInstalled()) {
    cb(getUnblockVersion());
  }
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ version?: string }>).detail;
    cb(detail?.version ?? getUnblockVersion());
  };
  window.addEventListener("vidsync-unblock-ready", handler);
  // poll dataset once shortly after load (content_scripts document_start races)
  const t = window.setTimeout(() => {
    if (isUnblockInstalled()) cb(getUnblockVersion());
  }, 50);
  return () => {
    window.clearTimeout(t);
    window.removeEventListener("vidsync-unblock-ready", handler);
  };
}
