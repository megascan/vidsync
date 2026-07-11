import {
  base64ToArrayBuffer,
  base64ToBlob,
  isUnblockInstalled,
  unblockFetch,
  withUnblockCacheBust,
} from "../unblock/bridge";

export type SourceHandle = {
  destroy: () => void;
};

type HlsLike = {
  destroy: () => void;
  loadSource: (url: string) => void;
  attachMedia: (video: HTMLVideoElement) => void;
  startLoad: () => void;
  recoverMediaError: () => void;
  on: (event: string, cb: (event: unknown, data: HlsErrorData) => void) => void;
};

type HlsErrorData = {
  fatal: boolean;
  type: string;
};

type HlsModule = {
  default: {
    isSupported: () => boolean;
    Events: { ERROR: string };
    ErrorTypes: { NETWORK_ERROR: string; MEDIA_ERROR: string };
    DefaultConfig: { loader: new (config: unknown) => HlsLoaderInstance };
    new (config?: Record<string, unknown>): HlsLike;
  };
};

type HlsLoaderInstance = {
  load: (
    context: HlsLoaderContext,
    config: unknown,
    callbacks: HlsLoaderCallbacks,
  ) => void;
  abort: () => void;
  destroy: () => void;
};

type HlsLoaderContext = {
  url: string;
  responseType: string;
  rangeStart?: number;
  rangeEnd?: number;
};

type HlsLoaderCallbacks = {
  onSuccess: (
    response: { url: string; data: string | ArrayBuffer },
    stats: Record<string, unknown>,
    context: HlsLoaderContext,
    networkDetails: unknown,
  ) => void;
  onError: (
    error: { code: number; text: string },
    context: HlsLoaderContext,
    networkDetails: unknown,
    stats: unknown,
  ) => void;
};

export type AttachSourceOptions = {
  preferUnblock?: boolean;
  /** User clicked Open with Unblock — stream via CORS shim / Range / HLS. */
  forceUnblock?: boolean;
  onStatus?: (message: string) => void;
  onSettled?: () => void;
};

function looksLikeHls(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".m3u8") ||
    lower.includes("application/vnd.apple.mpegurl") ||
    lower.includes("application/x-mpegurl")
  );
}

function guessMime(url: string, headers?: Record<string, string>): string {
  const ct = headers?.["content-type"] ?? headers?.["Content-Type"];
  if (ct && !ct.includes("text/html")) return ct.split(";")[0]?.trim() ?? ct;
  const lower = url.toLowerCase();
  if (lower.includes(".m3u8")) return "application/vnd.apple.mpegurl";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

/** HLS segments only — Range-aware, falls back to default loader. */
function makeUnblockLoader(
  DefaultLoader: new (config: unknown) => HlsLoaderInstance,
): new (config: unknown) => HlsLoaderInstance {
  return function UnblockLoader(this: HlsLoaderInstance, config: unknown) {
    const base = new DefaultLoader(config);
    this.abort = () => base.abort();
    this.destroy = () => base.destroy();
    this.load = (
      context: HlsLoaderContext,
      loaderConfig: unknown,
      callbacks: HlsLoaderCallbacks,
    ) => {
      const headers: Record<string, string> = {};
      if (
        context.rangeEnd !== undefined &&
        context.rangeStart !== undefined
      ) {
        headers.Range = `bytes=${context.rangeStart}-${context.rangeEnd - 1}`;
      }

      const stats: Record<string, unknown> = {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: performance.now(), first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      };

      void unblockFetch(context.url, { headers })
        .then((res) => {
          if (!res.ok || !res.bodyBase64) {
            // DNR may already allow page XHR — use stock loader (streaming)
            base.load(context, loaderConfig, callbacks);
            return;
          }
          const raw = base64ToArrayBuffer(res.bodyBase64);
          const payload: string | ArrayBuffer =
            context.responseType === "text" || context.responseType === "json"
              ? new TextDecoder().decode(raw)
              : raw;

          const loading = stats.loading as {
            start: number;
            first: number;
            end: number;
          };
          loading.first = performance.now();
          loading.end = performance.now();
          stats.loaded =
            typeof payload === "string" ? payload.length : payload.byteLength;
          stats.total = stats.loaded;

          callbacks.onSuccess(
            { url: context.url, data: payload },
            stats,
            context,
            null,
          );
        })
        .catch(() => {
          base.load(context, loaderConfig, callbacks);
        });
    };
  } as unknown as new (config: unknown) => HlsLoaderInstance;
}

/** Small files only (≤32MB). Large progressive = CORS + native Range only. */
async function attachProgressiveUnblockBlob(
  video: HTMLVideoElement,
  url: string,
  onError: (message: string) => void,
  onStatus?: (message: string) => void,
): Promise<() => void> {
  onStatus?.("Checking size…");
  const head = await unblockFetch(url, {
    method: "HEAD",
    responseType: "headers-only",
  });
  if (head.ok) {
    const lenRaw =
      head.headers["content-length"] ?? head.headers["Content-Length"];
    const len = lenRaw ? Number(lenRaw) : NaN;
    if (Number.isFinite(len) && len > 32 * 1024 * 1024) {
      onError(
        `~${Math.round(len / 1024 / 1024)}MB file — streaming with Range, not full download. Use Open with Unblock (CORS stream).`,
      );
      return () => undefined;
    }
  }

  onStatus?.("Fetching small file via Unblock…");
  const res = await unblockFetch(url);
  if (!res.ok || !res.bodyBase64) {
    onError(
      res.ok
        ? "Empty body"
        : (res.message ?? res.error ?? "Unblock fetch failed"),
    );
    return () => undefined;
  }
  const mime = guessMime(url, res.headers);
  const blob = base64ToBlob(res.bodyBase64, mime);
  const objectUrl = URL.createObjectURL(blob);
  video.removeAttribute("crossorigin");
  video.src = objectUrl;
  video.load();
  onStatus?.("Loaded small file via Unblock");
  return () => URL.revokeObjectURL(objectUrl);
}

/**
 * Stream progressive media: browser Range requests + extension CORS headers.
 * Never downloads the whole multi‑GB file into memory.
 */
function attachProgressiveStream(
  video: HTMLVideoElement,
  url: string,
  onError: (message: string) => void,
  destroyed: () => boolean,
  onStatus?: (message: string) => void,
  onSettled?: () => void,
): () => void {
  const bust = withUnblockCacheBust(url);
  onStatus?.(
    "Streaming with browser Range (CORS shim). Not downloading the whole file…",
  );

  video.removeAttribute("crossorigin");
  // preload=auto lets the browser pull ranges as needed
  video.preload = "auto";
  video.src = bust;
  video.load();

  const onCanPlay = () => {
    if (destroyed()) return;
    onStatus?.("Streaming — seek/play should work");
    onSettled?.();
  };
  const onMeta = () => {
    if (destroyed()) return;
    const d = video.duration;
    if (Number.isFinite(d) && d > 0) {
      onStatus?.(
        `Stream ready (~${Math.round(d / 60)} min). Native Range seeking.`,
      );
    }
  };
  const onErr = () => {
    if (destroyed()) return;
    const code = video.error?.code;
    onError(
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? "Stream blocked. Origin may not support Range, or Unblock CORS shim didn’t apply — reload extension + tab."
        : "Stream network error. Check URL is reachable from your machine.",
    );
    onSettled?.();
  };

  video.addEventListener("canplay", onCanPlay, { once: true });
  video.addEventListener("loadedmetadata", onMeta, { once: true });
  video.addEventListener("error", onErr, { once: true });

  const settleTimer = window.setTimeout(() => {
    if (!destroyed()) {
      onStatus?.(
        "Stream request in flight (large files buffer slowly). Use the scrubber after metadata loads.",
      );
      onSettled?.();
    }
  }, 3000);

  return () => {
    window.clearTimeout(settleTimer);
    video.removeEventListener("canplay", onCanPlay);
    video.removeEventListener("loadedmetadata", onMeta);
    video.removeEventListener("error", onErr);
  };
}

export function attachVideoSource(
  video: HTMLVideoElement,
  url: string,
  onError: (message: string) => void,
  options?: AttachSourceOptions,
): SourceHandle {
  let destroyed = false;
  let hls: HlsLike | null = null;
  let revokeBlob: (() => void) | null = null;
  let extraCleanup: (() => void) | null = null;
  const preferUnblock = options?.preferUnblock !== false;
  const forceUnblock = Boolean(options?.forceUnblock);
  const onStatus = options?.onStatus;
  const onSettled = options?.onSettled;

  const isDestroyed = () => destroyed;
  const settled = () => {
    if (!destroyed) onSettled?.();
  };

  const onVideoError = () => {
    const err = video.error;
    const code = err?.code;
    // Small-file blob fallback only (not multi‑GB)
    if (
      preferUnblock &&
      !looksLikeHls(url) &&
      !revokeBlob &&
      !forceUnblock &&
      (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
        code === MediaError.MEDIA_ERR_NETWORK)
    ) {
      void attachProgressiveUnblockBlob(video, url, onError, onStatus).then(
        (revoke) => {
          if (destroyed) {
            revoke();
            settled();
            return;
          }
          revokeBlob = revoke;
          settled();
        },
      );
      return;
    }
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      onError(
        "Source not supported or blocked. Click “Open with Unblock” to enable streaming CORS.",
      );
    } else if (code === MediaError.MEDIA_ERR_NETWORK) {
      onError("Network error. Check URL / click Open with Unblock.");
    } else {
      onError("Failed to load media.");
    }
    settled();
  };

  video.addEventListener("error", onVideoError);

  if (looksLikeHls(url)) {
    const canNative =
      video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
      video.canPlayType("application/x-mpegURL") !== "";
    const playUrl = forceUnblock ? withUnblockCacheBust(url) : url;
    onStatus?.(
      forceUnblock
        ? "Streaming HLS (CORS + segment loader)…"
        : "Loading HLS…",
    );

    void import("hls.js").then((mod) => {
      if (destroyed) {
        settled();
        return;
      }
      const Hls = (mod as unknown as HlsModule).default;
      if (Hls.isSupported()) {
        const config: Record<string, unknown> = {
          enableWorker: true,
          lowLatencyMode: false,
        };
        if (forceUnblock || (preferUnblock && isUnblockInstalled())) {
          config.loader = makeUnblockLoader(Hls.DefaultConfig.loader);
        }
        const instance = new Hls(config) as HlsLike;
        hls = instance;
        instance.loadSource(playUrl);
        instance.attachMedia(video);
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            onError(
              "HLS stream network error. Check URL reachability / Unblock.",
            );
            instance.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            instance.recoverMediaError();
          } else {
            onError("Fatal HLS error.");
            instance.destroy();
          }
          settled();
        });
        window.setTimeout(settled, 800);
      } else if (canNative) {
        video.removeAttribute("crossorigin");
        video.src = playUrl;
        settled();
      } else {
        onError("HLS not supported in this browser.");
        settled();
      }
    });
  } else if (forceUnblock) {
    // Progressive multi‑GB: stream only (CORS + native Range). Never full download.
    extraCleanup = attachProgressiveStream(
      video,
      url,
      onError,
      isDestroyed,
      onStatus,
      settled,
    );
  } else {
    video.removeAttribute("crossorigin");
    video.src = url;
    settled();
  }

  return {
    destroy: () => {
      destroyed = true;
      video.removeEventListener("error", onVideoError);
      extraCleanup?.();
      extraCleanup = null;
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (revokeBlob) {
        revokeBlob();
        revokeBlob = null;
      }
      video.removeAttribute("src");
      video.load();
    },
  };
}
