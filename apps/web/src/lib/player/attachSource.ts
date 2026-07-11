import {
  base64ToArrayBuffer,
  base64ToBlob,
  isUnblockInstalled,
  unblockFetch,
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
  config: { loader: unknown };
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
  onTimeout?: (
    stats: unknown,
    context: HlsLoaderContext,
    networkDetails: unknown,
  ) => void;
  onProgress?: (
    stats: unknown,
    context: HlsLoaderContext,
    data: unknown,
    networkDetails: unknown,
  ) => void;
};

export type AttachSourceOptions = {
  /** Prefer extension fetch when installed (HLS always; progressive on failure or force). */
  preferUnblock?: boolean;
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
      if (!isUnblockInstalled()) {
        base.load(context, loaderConfig, callbacks);
        return;
      }

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
            callbacks.onError(
              {
                code: res.status ?? 0,
                text: res.ok ? "empty_body" : (res.message ?? res.error),
              },
              context,
              null,
              stats,
            );
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
        .catch((err: unknown) => {
          callbacks.onError(
            {
              code: 0,
              text: err instanceof Error ? err.message : "unblock_fetch_failed",
            },
            context,
            null,
            stats,
          );
        });
    };
  } as unknown as new (config: unknown) => HlsLoaderInstance;
}

async function attachProgressiveUnblock(
  video: HTMLVideoElement,
  url: string,
  onError: (message: string) => void,
): Promise<() => void> {
  const res = await unblockFetch(url);
  if (!res.ok || !res.bodyBase64) {
    onError(
      res.ok
        ? "Empty media body via Unblock"
        : (res.message ?? res.error ?? "Unblock fetch failed"),
    );
    return () => undefined;
  }
  const mime = guessMime(url, res.headers);
  const blob = base64ToBlob(res.bodyBase64, mime);
  const objectUrl = URL.createObjectURL(blob);
  video.src = objectUrl;
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

  const onVideoError = () => {
    const err = video.error;
    const code = err?.code;
    // Try extension progressive fallback once on network/src errors
    if (
      preferUnblock &&
      isUnblockInstalled() &&
      !looksLikeHls(url) &&
      !revokeBlob &&
      (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
        code === MediaError.MEDIA_ERR_NETWORK)
    ) {
      void attachProgressiveUnblock(video, url, onError).then((revoke) => {
        if (destroyed) {
          revoke();
          return;
        }
        revokeBlob = revoke;
      });
      return;
    }
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      onError("Source not supported or blocked (often CORS). Try VidSync Unblock.");
    } else if (code === MediaError.MEDIA_ERR_NETWORK) {
      onError("Network error loading media. Try VidSync Unblock or check URL.");
    } else {
      onError("Failed to load media.");
    }
  };

  video.addEventListener("error", onVideoError);

  if (looksLikeHls(url)) {
    const canNative =
      video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
      video.canPlayType("application/x-mpegURL") !== "";

    void import("hls.js").then((mod) => {
      if (destroyed) return;
      const Hls = (mod as unknown as HlsModule).default;
      if (Hls.isSupported()) {
        const config: Record<string, unknown> = {
          enableWorker: true,
          lowLatencyMode: false,
        };
        if (preferUnblock && isUnblockInstalled()) {
          config.loader = makeUnblockLoader(Hls.DefaultConfig.loader);
        }
        const instance = new Hls(config) as HlsLike;
        hls = instance;
        instance.loadSource(url);
        instance.attachMedia(video);
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            onError(
              isUnblockInstalled()
                ? "HLS network error (even with Unblock). Check URL."
                : "HLS network error — install VidSync Unblock or fix CORS.",
            );
            instance.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            instance.recoverMediaError();
          } else {
            onError("Fatal HLS error.");
            instance.destroy();
          }
        });
      } else if (canNative) {
        video.src = url;
      } else {
        onError("HLS not supported in this browser.");
      }
    });
  } else {
    // Progressive: try direct first (often works without CORS on <video>).
    // On error, onVideoError falls back to Unblock blob path (≤80MB).
    video.src = url;
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
