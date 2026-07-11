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

function looksLikeHls(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".m3u8") ||
    lower.includes("application/vnd.apple.mpegurl") ||
    lower.includes("application/x-mpegurl")
  );
}

export function attachVideoSource(
  video: HTMLVideoElement,
  url: string,
  onError: (message: string) => void,
): SourceHandle {
  let destroyed = false;
  let hls: HlsLike | null = null;

  const onVideoError = () => {
    const err = video.error;
    const code = err?.code;
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      onError("Source not supported or blocked (often CORS).");
    } else if (code === MediaError.MEDIA_ERR_NETWORK) {
      onError("Network error loading media (CORS or offline).");
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
      const Hls = mod.default;
      if (Hls.isSupported()) {
        const instance = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
        }) as unknown as HlsLike & {
          on: (
            event: string,
            cb: (event: unknown, data: HlsErrorData) => void,
          ) => void;
        };
        hls = instance;
        instance.loadSource(url);
        instance.attachMedia(video);
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            onError("HLS network error — check CORS and URL.");
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
      video.removeAttribute("src");
      video.load();
    },
  };
}
