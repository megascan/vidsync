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
  /** User clicked Open with Unblock — CORS shim + extension loaders / blob. */
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
            // Fall back to normal loader (DNR may have fixed CORS)
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

/** Only for small files. Large progressive media uses CORS shim + native Range. */
async function attachProgressiveUnblockBlob(
  video: HTMLVideoElement,
  url: string,
  onError: (message: string) => void,
  onStatus?: (message: string) => void,
): Promise<() => void> {
  onStatus?.("Checking size via Unblock…");
  const head = await unblockFetch(url, {
    method: "HEAD",
    responseType: "headers-only",
  });
  if (head.ok) {
    const lenRaw =
      head.headers["content-length"] ?? head.headers["Content-Length"];
    const len = lenRaw ? Number(lenRaw) : NaN;
    if (Number.isFinite(len) && len > 80 * 1024 * 1024) {
      onError(
        `File is ~${Math.round(len / 1024 / 1024)}MB — too large to download whole. CORS shim is on; use Open with Unblock (native Range play) or switch to HLS.`,
      );
      return () => undefined;
    }
  }

  onStatus?.("Fetching small file via Unblock…");
  const res = await unblockFetch(url);
  if (!res.ok || !res.bodyBase64) {
    const msg = res.ok
      ? "Empty media body via Unblock"
      : (res.message ?? res.error ?? "Unblock fetch failed");
    onError(msg);
    return () => undefined;
  }
  const mime = guessMime(url, res.headers);
  const blob = base64ToBlob(res.bodyBase64, mime);
  const objectUrl = URL.createObjectURL(blob);
  video.src = objectUrl;
  video.load();
  onStatus?.("Loaded via Unblock blob");
  return () => {
    URL.revokeObjectURL(objectUrl);
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
  const preferUnblock = options?.preferUnblock !== false;
  const forceUnblock = Boolean(options?.forceUnblock);
  const onStatus = options?.onStatus;
  const onSettled = options?.onSettled;

  const settled = () => {
    if (!destroyed) onSettled?.();
  };

  const onVideoError = () => {
    const err = video.error;
    const code = err?.code;
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
        "Source not supported or blocked (often CORS). Click “Open with Unblock”.",
      );
    } else if (code === MediaError.MEDIA_ERR_NETWORK) {
      onError(
        "Network error loading media. Click “Open with Unblock” or check URL.",
      );
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
        ? "Loading HLS via Unblock (CORS shim + loader)…"
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
        // Always use extension loader when force, or when installed + prefer
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
              forceUnblock || isUnblockInstalled()
                ? "HLS network error even with Unblock. Check the URL is reachable."
                : "HLS network error — install VidSync Unblock or fix CORS.",
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
        // HLS may not fire error — settle after short delay for UI
        window.setTimeout(settled, 800);
      } else if (canNative && !forceUnblock) {
        video.src = playUrl;
        settled();
      } else {
        onError("HLS not supported in this browser.");
        settled();
      }
    });
  } else if (forceUnblock) {
    // Large progressive (GB): never full-download. DNR CORS shim + native
    // <video> Range seeking is the only workable path.
    const bust = withUnblockCacheBust(url);
    onStatus?.(
      "CORS shim on — streaming with browser Range (no full download)…",
    );
    // Avoid crossorigin so the element can play without tainting/strict CORS
    video.removeAttribute("crossorigin");
    video.src = bust;
    video.load();

    const onCanPlay = () => {
      onStatus?.("Streaming (Unblock CORS + Range)");
      settled();
    };
    const onLoadedMeta = () => {
      onStatus?.("Metadata loaded — seeking/play should work");
    };
    video.addEventListener("canplay", onCanPlay, { once: true });
    video.addEventListener("loadedmetadata", onLoadedMeta, { once: true });

    // Don't auto full-download if buffering is slow (multi-GB is normal)
    const settleTimer = window.setTimeout(() => {
      if (!destroyed) {
        onStatus?.(
          "Stream requested via Unblock. If it still fails, origin may block Range or the URL is unreachable.",
        );
        settled();
      }
    }, 2500);

    return {
      destroy: () => {
        destroyed = true;
        window.clearTimeout(settleTimer);
        video.removeEventListener("canplay", onCanPlay);
        video.removeEventListener("loadedmetadata", onLoadedMeta);
        video.removeEventListener("error", onVideoError);
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
  } else {
    video.src = url;
    settled();
  }

  return {
    destroy: () => {
      destroyed = true;
      video.removeEventListener("error", onVideoError);
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
