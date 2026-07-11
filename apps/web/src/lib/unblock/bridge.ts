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

export type PlayerTick = {
  positionMs: number;
  isPlaying: boolean;
  durationMs: number | null;
  videoUrl: string | null;
};

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
const tickListeners = new Set<(t: PlayerTick) => void>();
let listening = false;

declare global {
  interface Window {
    __VIDSYNC_UNBLOCK__?: {
      version?: string;
      ready?: boolean;
      channel?: string;
      mode?: string;
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
      positionMs?: number;
      isPlaying?: boolean;
      durationMs?: number | null;
      videoUrl?: string | null;
      [key: string]: unknown;
    } | null;
    if (!data || data.channel !== CHANNEL) return;

    if (data.direction === "event" && data.type === "ready") {
      window.dispatchEvent(
        new CustomEvent("vidsync-unblock-ready", {
          detail: { version: data.version ?? null, ready: true },
        }),
      );
      return;
    }

    if (data.direction === "event" && data.type === "player_tick") {
      const tick: PlayerTick = {
        positionMs: Number(data.positionMs) || 0,
        isPlaying: Boolean(data.isPlaying),
        durationMs:
          typeof data.durationMs === "number" ? data.durationMs : null,
        videoUrl: typeof data.videoUrl === "string" ? data.videoUrl : null,
      };
      for (const cb of tickListeners) cb(tick);
      return;
    }

    if (data.direction !== "response") return;
    if (typeof data.id !== "string") return;
    const p = pending.get(data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(data.id);
    p.resolve(data as Record<string, unknown>);
  });
}

function requestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pageRequest(
  type: string,
  payload?: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
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

export async function pingUnblock(): Promise<{
  ok: boolean;
  version: string | null;
  mode?: string;
}> {
  if (typeof window === "undefined") return { ok: false, version: null };
  ensureListener();
  try {
    const res = await pageRequest("ping", undefined, 2500);
    return {
      ok: Boolean(res.ok),
      version: typeof res.version === "string" ? res.version : getUnblockVersion(),
      mode: typeof res.mode === "string" ? res.mode : undefined,
    };
  } catch {
    if (isUnblockInstalled()) {
      return { ok: true, version: getUnblockVersion() };
    }
    return { ok: false, version: null };
  }
}

/** Open extension player popup/window and load stream URL (Range streaming, no page CORS). */
export async function openUnblockPlayer(
  url: string,
  state?: {
    videoUrl?: string | null;
    isPlaying?: boolean;
    positionMs?: number;
  } | null,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await pageRequest(
      "open_player",
      { url, state: state ?? null },
      8000,
    );
    return {
      ok: Boolean(res.ok),
      message:
        typeof res.message === "string"
          ? res.message
          : typeof res.error === "string"
            ? res.error
            : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "open_player failed",
    };
  }
}

/** Push full playback state to extension player (followers / resync). */
export async function pushUnblockPlayerState(state: {
  videoUrl: string | null;
  isPlaying: boolean;
  positionMs: number;
}): Promise<void> {
  try {
    await pageRequest("player_state", { state }, 3000);
  } catch {
    // player may be closed
  }
}

/** Host control → extension player */
export async function pushUnblockPlayerControl(ctrl: {
  controlType: "play" | "pause" | "seek";
  positionMs: number;
  isPlaying?: boolean;
}): Promise<void> {
  try {
    await pageRequest("player_control", ctrl, 3000);
  } catch {
    // ignore
  }
}

export function onUnblockPlayerTick(cb: (t: PlayerTick) => void): () => void {
  ensureListener();
  tickListeners.add(cb);
  return () => {
    tickListeners.delete(cb);
  };
}

export async function enableUnblockCors(): Promise<{
  ok: boolean;
  message?: string;
}> {
  try {
    const res = await pageRequest("enable_cors", undefined, 3000);
    return { ok: Boolean(res.ok) };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "timeout",
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
    return res as unknown as UnblockFetchResponse;
  } catch (e) {
    return {
      ok: false,
      error: "bridge_timeout",
      message: e instanceof Error ? e.message : "bridge timeout",
    };
  }
}

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

export function onUnblockReady(
  cb: (version: string | null) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  let stopped = false;
  const fire = (v: string | null) => {
    if (!stopped) cb(v);
  };

  if (isUnblockInstalled()) fire(getUnblockVersion());

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ version?: string }>).detail;
    fire(detail?.version ?? getUnblockVersion());
  };
  window.addEventListener("vidsync-unblock-ready", handler);

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
