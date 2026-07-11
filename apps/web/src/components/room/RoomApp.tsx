import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOST_HEARTBEAT_MS,
  isAllowedVideoUrl,
  type PlaybackState,
} from "@vidsync/shared";
import { wsUrlForRoom } from "../../lib/api";
import { loadNickname, saveNickname } from "../../lib/nickname";
import { attachVideoSource, type SourceHandle } from "../../lib/player/attachSource";
import { parseRoomCodeFromLocation } from "../../lib/roomCode";
import { applyDrift, SyncClient } from "../../lib/sync/client";
import { useRoomStore } from "../../lib/store/roomStore";

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function RoomApp() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clientRef = useRef<SyncClient | null>(null);
  const sourceRef = useRef<SourceHandle | null>(null);
  const applyingRemote = useRef(false);
  const lastVersion = useRef(-1);

  const {
    code,
    sessionId,
    isHost,
    playback,
    members,
    conn,
    clockOffsetMs,
    lastError,
    mediaError,
    setCode,
    setNickname,
    setConn,
    setWelcome,
    setPlayback,
    setMembers,
    setClockOffset,
    setLastError,
    setMediaError,
  } = useRoomStore();

  const [urlDraft, setUrlDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [nickDraft, setNickDraft] = useState("");

  // Resolve code from location
  useEffect(() => {
    const resolved = parseRoomCodeFromLocation(
      window.location.pathname,
      window.location.search,
    );
    if (!resolved) {
      setLastError("Missing room code. Open a link like /r/XXXXXXXX");
      return;
    }
    setCode(resolved);
    // keep pretty URL if landed on /room?code=
    if (!window.location.pathname.startsWith("/r/")) {
      window.history.replaceState(null, "", `/r/${resolved}`);
    }
    const nick = loadNickname();
    setNickname(nick);
    setNickDraft(nick);
  }, [setCode, setLastError, setNickname]);

  // Connect WS
  useEffect(() => {
    if (!code) return;
    const nick = loadNickname();
    const client = new SyncClient(wsUrlForRoom(code), nick, {
      onConn: setConn,
      onWelcome: (p) => {
        setWelcome(p);
        setUrlDraft(p.state.videoUrl ?? "");
        lastVersion.current = p.state.version;
      },
      onState: (state) => {
        setPlayback(state);
      },
      onMembers: setMembers,
      onError: (c, message) => setLastError(`${c}: ${message}`),
      onClock: setClockOffset,
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [
    code,
    setClockOffset,
    setConn,
    setLastError,
    setMembers,
    setPlayback,
    setWelcome,
  ]);

  // Attach media source when URL changes
  useEffect(() => {
    const video = videoRef.current;
    const url = playback?.videoUrl;
    if (!video) return;

    sourceRef.current?.destroy();
    sourceRef.current = null;
    setMediaError(null);

    if (!url) return;

    sourceRef.current = attachVideoSource(video, url, setMediaError);
    return () => {
      sourceRef.current?.destroy();
      sourceRef.current = null;
    };
  }, [playback?.videoUrl, setMediaError]);

  // Apply remote playback state
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback) return;
    if (playback.version === lastVersion.current && !isHost) {
      // still drift-correct on same version via interval
    }
    lastVersion.current = playback.version;

    applyingRemote.current = true;
    applyDrift(video, playback, clockOffsetMs);

    const run = async () => {
      try {
        if (playback.isPlaying) {
          if (video.paused) await video.play();
        } else if (!video.paused) {
          video.pause();
        }
      } catch {
        // autoplay blocked — user gesture needed
      } finally {
        queueMicrotask(() => {
          applyingRemote.current = false;
        });
      }
    };
    void run();
  }, [playback, clockOffsetMs, isHost]);

  // Periodic drift for followers + host heartbeat
  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current;
      const client = clientRef.current;
      const state = useRoomStore.getState().playback;
      const host = useRoomStore.getState().isHost;
      const offset = useRoomStore.getState().clockOffsetMs;
      if (!video || !state) return;

      if (!host) {
        applyDrift(video, state, offset);
      } else if (state.isPlaying && client) {
        client.send({
          type: "heartbeat",
          positionMs: video.currentTime * 1000,
          isPlaying: !video.paused,
        });
      }
    }, HOST_HEARTBEAT_MS);

    return () => window.clearInterval(id);
  }, []);

  const sendHost = useCallback(
    (fn: (positionMs: number) => void) => {
      if (!isHost || !clientRef.current || !videoRef.current) return;
      fn(videoRef.current.currentTime * 1000);
    },
    [isHost],
  );

  const onPlayClick = () => {
    sendHost((positionMs) => {
      clientRef.current?.send({ type: "play", positionMs });
      void videoRef.current?.play();
    });
  };

  const onPauseClick = () => {
    sendHost((positionMs) => {
      clientRef.current?.send({ type: "pause", positionMs });
      videoRef.current?.pause();
    });
  };

  const onSeek = (value: number) => {
    const video = videoRef.current;
    if (!video || !isHost) return;
    const positionMs = value * 1000;
    video.currentTime = value;
    clientRef.current?.send({
      type: "seek",
      positionMs,
      isPlaying: !video.paused,
    });
  };

  const onSetUrl = () => {
    const url = urlDraft.trim();
    if (!isHost) return;
    if (!isAllowedVideoUrl(url)) {
      setLastError("URL must be public https");
      return;
    }
    clientRef.current?.send({ type: "set_url", url });
  };

  const onSaveNick = () => {
    const n = nickDraft.trim().slice(0, 24);
    if (!n) return;
    saveNickname(n);
    setNickname(n);
    clientRef.current?.setNickname(n);
  };

  const onCopy = async () => {
    if (!code) return;
    const link = `${window.location.origin}/r/${code}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setLastError("Could not copy link");
    }
  };

  const onVideoPlay = () => {
    if (applyingRemote.current || !isHost) {
      if (!isHost && videoRef.current && playback && !playback.isPlaying) {
        videoRef.current.pause();
      }
      return;
    }
    sendHost((positionMs) => {
      clientRef.current?.send({ type: "play", positionMs });
    });
  };

  const onVideoPause = () => {
    if (applyingRemote.current || !isHost) {
      if (!isHost && videoRef.current && playback?.isPlaying) {
        void videoRef.current.play().catch(() => undefined);
      }
      return;
    }
    sendHost((positionMs) => {
      clientRef.current?.send({ type: "pause", positionMs });
    });
  };

  const duration = videoRef.current?.duration;
  const durationOk = duration != null && Number.isFinite(duration);

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-4 px-3 py-4 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <a
            href="/"
            className="font-mono text-xs tracking-widest text-[var(--color-accent)] uppercase"
          >
            VidSync
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg tracking-widest">{code ?? "……"}</span>
            {isHost ? (
              <span className="rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]">
                Host
              </span>
            ) : (
              <span className="rounded bg-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
                Viewer
              </span>
            )}
            <ConnBadge conn={conn} />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onCopy()}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            href="/"
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted)]"
          >
            Leave
          </a>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
        <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-black">
          <video
            ref={videoRef}
            className="aspect-video w-full bg-black"
            playsInline
            controls={isHost}
            onPlay={onVideoPlay}
            onPause={onVideoPause}
          />
          <div className="flex flex-col gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            {!isHost ? (
              <p className="text-xs text-[var(--color-muted)]">
                Host controls playback. Stay on this tab for best sync.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onPlayClick}
                  className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-black"
                >
                  Play
                </button>
                <button
                  type="button"
                  onClick={onPauseClick}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
                >
                  Pause
                </button>
                {durationOk ? (
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.1}
                    defaultValue={0}
                    onChange={(e) => onSeek(Number(e.target.value))}
                    className="min-w-[120px] flex-1"
                    aria-label="Seek"
                  />
                ) : null}
                <span className="font-mono text-xs text-[var(--color-muted)]">
                  {playback
                    ? formatTime(playback.positionMs)
                    : "0:00"}
                  {durationOk ? ` / ${formatTime(duration * 1000)}` : ""}
                </span>
              </div>
            )}

            {isHost ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  placeholder="https://…/video.mp4 or .m3u8"
                  className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={onSetUrl}
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm whitespace-nowrap"
                >
                  Set URL
                </button>
              </div>
            ) : (
              <p className="truncate font-mono text-xs text-[var(--color-muted)]">
                {playback?.videoUrl ?? "No video set"}
              </p>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-3">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
              In room ({members.length})
            </h2>
            <ul className="mt-2 flex flex-col gap-1.5">
              {members.map((m) => (
                <li
                  key={m.sessionId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className={m.sessionId === sessionId ? "font-medium" : ""}>
                    {m.nickname}
                    {m.sessionId === sessionId ? " (you)" : ""}
                  </span>
                  {m.isHost ? (
                    <span className="text-xs text-[var(--color-accent)]">host</span>
                  ) : null}
                </li>
              ))}
              {members.length === 0 ? (
                <li className="text-xs text-[var(--color-muted)]">Connecting…</li>
              ) : null}
            </ul>
          </div>

          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <label className="text-xs text-[var(--color-muted)]">
              Nickname
              <div className="mt-1 flex gap-2">
                <input
                  value={nickDraft}
                  onChange={(e) => setNickDraft(e.target.value)}
                  maxLength={24}
                  className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none"
                />
                <button
                  type="button"
                  onClick={onSaveNick}
                  className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs"
                >
                  Save
                </button>
              </div>
            </label>
            <p className="mt-2 text-[11px] leading-snug text-[var(--color-muted)]">
              Session: {sessionId?.slice(0, 8) ?? "—"}
            </p>
          </div>
        </aside>
      </div>

      {lastError ? (
        <p className="text-sm text-[var(--color-danger)]" role="alert">
          {lastError}
        </p>
      ) : null}
      {mediaError ? (
        <p className="text-sm text-[var(--color-danger)]" role="alert">
          Media: {mediaError}
        </p>
      ) : null}

      <StateDebug playback={playback} />
    </div>
  );
}

function ConnBadge({ conn }: { conn: string }) {
  const color =
    conn === "open"
      ? "text-[var(--color-accent)]"
      : conn === "connecting"
        ? "text-yellow-400"
        : "text-[var(--color-danger)]";
  return <span className={`text-xs ${color}`}>{conn}</span>;
}

function StateDebug({ playback }: { playback: PlaybackState | null }) {
  if (!playback) return null;
  return (
    <details className="text-xs text-[var(--color-muted)]">
      <summary className="cursor-pointer">Sync state</summary>
      <pre className="mt-1 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono">
        {JSON.stringify(
          {
            version: playback.version,
            isPlaying: playback.isPlaying,
            positionMs: Math.round(playback.positionMs),
            host: playback.hostSessionId?.slice(0, 8),
          },
          null,
          2,
        )}
      </pre>
    </details>
  );
}
