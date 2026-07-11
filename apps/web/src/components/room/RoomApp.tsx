import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOST_HEARTBEAT_MS,
  MAX_CHAT_LENGTH,
  isAllowedVideoUrl,
  type PlaybackState,
} from "@vidsync/shared";
import { wsUrlForRoom } from "../../lib/api";
import {
  loadNickname,
  loadStoredNickname,
  normalizeNickname,
  saveNickname,
} from "../../lib/nickname";
import {
  attachVideoSource,
  type SourceHandle,
} from "../../lib/player/attachSource";
import { parseRoomCodeFromLocation } from "../../lib/roomCode";
import { applyDrift, SyncClient } from "../../lib/sync/client";
import { useRoomStore } from "../../lib/store/roomStore";

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path =
      u.pathname.length > 28 ? `${u.pathname.slice(0, 28)}…` : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url.slice(0, 48);
  }
}

function formatChatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function RoomApp() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clientRef = useRef<SyncClient | null>(null);
  const sourceRef = useRef<SourceHandle | null>(null);
  const applyingRemote = useRef(false);
  const lastVersion = useRef(-1);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const {
    code,
    sessionId,
    isHost,
    playback,
    members,
    chat,
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
    pushChat,
    clearChat,
    setClockOffset,
    setLastError,
    setMediaError,
  } = useRoomStore();

  const [urlDraft, setUrlDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [nickDraft, setNickDraft] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  /** Wait for nick pick before opening WS when no local nick yet */
  const [nickReady, setNickReady] = useState(false);

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
    if (!window.location.pathname.startsWith("/r/")) {
      window.history.replaceState(null, "", `/r/${resolved}`);
    }

    const stored = loadStoredNickname();
    if (stored) {
      setNickname(stored);
      setNickDraft(stored);
      setNickReady(true);
    } else {
      setNickDraft("");
      setNickReady(false);
    }
  }, [setCode, setLastError, setNickname]);

  const enterWithNick = () => {
    const n = normalizeNickname(nickDraft);
    if (!n) {
      setLastError("Enter a nickname to join");
      return;
    }
    saveNickname(n);
    setNickname(n);
    setNickDraft(n);
    setLastError(null);
    setNickReady(true);
  };

  // Connect only after nick is ready
  useEffect(() => {
    if (!code || !nickReady) return;
    const nick = loadNickname();
    clearChat();
    const client = new SyncClient(wsUrlForRoom(code), nick, {
      onConn: setConn,
      onWelcome: (p) => {
        setWelcome(p);
        lastVersion.current = p.state.version;
      },
      onState: (state) => {
        setPlayback(state);
      },
      onMembers: setMembers,
      onChat: pushChat,
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
    nickReady,
    clearChat,
    pushChat,
    setClockOffset,
    setConn,
    setLastError,
    setMembers,
    setPlayback,
    setWelcome,
  ]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.length]);

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback) return;
    lastVersion.current = playback.version;

    if (!playback.videoUrl) {
      video.pause();
      return;
    }

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
        // autoplay blocked
      } finally {
        queueMicrotask(() => {
          applyingRemote.current = false;
        });
      }
    };
    void run();
  }, [playback, clockOffsetMs, isHost]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current;
      const client = clientRef.current;
      const state = useRoomStore.getState().playback;
      const host = useRoomStore.getState().isHost;
      const offset = useRoomStore.getState().clockOffsetMs;
      if (!video || !state?.videoUrl) return;

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
    if (!playback?.videoUrl) {
      setLastError("Queue a video first");
      return;
    }
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

  const onQueueAdd = () => {
    const url = urlDraft.trim();
    if (!isHost) return;
    if (!isAllowedVideoUrl(url)) {
      setLastError(
        "Video URL must be http(s) — e.g. https://cdn…/file.mp4 or http://192.168.x.x/…",
      );
      return;
    }
    clientRef.current?.send({ type: "queue_add", url, playIfIdle: true });
    setUrlDraft("");
    setLastError(null);
  };

  const onQueuePlay = (index: number) => {
    if (!isHost) return;
    clientRef.current?.send({ type: "queue_play", index });
  };

  const onQueueRemove = (index: number) => {
    if (!isHost) return;
    clientRef.current?.send({ type: "queue_remove", index });
  };

  const onQueueClear = () => {
    if (!isHost) return;
    clientRef.current?.send({ type: "queue_clear" });
  };

  const onSaveNick = () => {
    const n = normalizeNickname(nickDraft);
    if (!n) return;
    saveNickname(n);
    setNickname(n);
    setNickDraft(n);
    clientRef.current?.setNickname(n);
  };

  const onSendChat = () => {
    const text = chatDraft.trim();
    if (!text || !clientRef.current) return;
    clientRef.current.sendChat(text.slice(0, MAX_CHAT_LENGTH));
    setChatDraft("");
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
    if (!playback?.videoUrl) return;
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

  // Nick gate before join
  if (!nickReady) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 px-4 py-12">
        <div>
          <a
            href="/"
            className="font-mono text-xs tracking-widest text-[var(--color-accent)] uppercase"
          >
            VidSync
          </a>
          <h1 className="mt-2 text-xl font-semibold">Pick a nickname</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Shown in the room and chat. Saved in this browser.
          </p>
        </div>
        <label className="block text-xs text-[var(--color-muted)]">
          Nickname
          <input
            type="text"
            value={nickDraft}
            onChange={(e) => setNickDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") enterWithNick();
            }}
            maxLength={24}
            autoFocus
            autoComplete="nickname"
            placeholder="e.g. strange"
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <button
          type="button"
          onClick={enterWithNick}
          className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-black"
        >
          Enter room {code ? `(${code})` : ""}
        </button>
        {lastError ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {lastError}
          </p>
        ) : null}
      </div>
    );
  }

  const duration = videoRef.current?.duration;
  const durationOk = duration != null && Number.isFinite(duration);
  const queue = playback?.queue ?? [];
  const queueIndex = playback?.queueIndex ?? null;
  const hasVideo = Boolean(playback?.videoUrl);

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
            <span className="font-mono text-lg tracking-widest">
              {code ?? "……"}
            </span>
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

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-3">
          <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-black">
            <video
              ref={videoRef}
              className={`aspect-video w-full bg-black ${hasVideo ? "" : "hidden"}`}
              playsInline
              controls={isHost}
              onPlay={onVideoPlay}
              onPause={onVideoPause}
            />
            {!hasVideo ? (
              <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-[var(--color-surface)] px-6 text-center">
                <p className="text-sm font-medium text-[var(--color-text)]">
                  Empty sync room
                </p>
                <p className="max-w-sm text-xs leading-relaxed text-[var(--color-muted)]">
                  {isHost
                    ? "Queue an http(s) stream URL to start watching together."
                    : "Waiting for the host to queue a video."}
                </p>
              </div>
            ) : null}
            <div className="flex flex-col gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              {!isHost ? (
                <p className="text-xs text-[var(--color-muted)]">
                  Host controls playback and queue. Stay on this tab for best
                  sync.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={onPlayClick}
                    disabled={!hasVideo}
                    className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    onClick={onPauseClick}
                    disabled={!hasVideo}
                    className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
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
                    {playback ? formatTime(playback.positionMs) : "0:00"}
                    {durationOk ? ` / ${formatTime(duration * 1000)}` : ""}
                  </span>
                </div>
              )}
              {hasVideo ? (
                <p className="truncate font-mono text-xs text-[var(--color-muted)]">
                  Now: {playback?.videoUrl}
                </p>
              ) : null}
            </div>
          </section>

          {/* Chat */}
          <section className="flex min-h-[220px] flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="border-b border-[var(--color-border)] px-3 py-2">
              <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
                Chat
              </h2>
              <p className="text-[10px] text-[var(--color-muted)]">
                Live only — not saved. Goes away when you leave.
              </p>
            </div>
            <div className="flex max-h-52 min-h-[140px] flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
              {chat.length === 0 ? (
                <p className="text-xs text-[var(--color-muted)]">
                  No messages yet. Say hi.
                </p>
              ) : (
                chat.map((m) => {
                  const mine = m.sessionId === sessionId;
                  return (
                    <div key={m.id} className="text-xs leading-snug">
                      <span className="font-mono text-[10px] text-[var(--color-muted)]">
                        {formatChatTime(m.serverTimeMs)}{" "}
                      </span>
                      <span
                        className={
                          mine
                            ? "font-medium text-[var(--color-accent)]"
                            : "font-medium"
                        }
                      >
                        {m.nickname}
                      </span>
                      <span className="text-[var(--color-muted)]">: </span>
                      <span className="break-words text-[var(--color-text)]">
                        {m.text}
                      </span>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-2 border-t border-[var(--color-border)] p-2">
              <input
                type="text"
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSendChat();
                  }
                }}
                maxLength={MAX_CHAT_LENGTH}
                placeholder={
                  conn === "open" ? "Message the room…" : "Connecting…"
                }
                disabled={conn !== "open"}
                className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
              />
              <button
                type="button"
                onClick={onSendChat}
                disabled={conn !== "open" || !chatDraft.trim()}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-3">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
                Queue ({queue.length})
              </h2>
              {isHost && queue.length > 0 ? (
                <button
                  type="button"
                  onClick={onQueueClear}
                  className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-danger)]"
                >
                  Clear
                </button>
              ) : null}
            </div>

            {isHost ? (
              <div className="mt-2 flex flex-col gap-2">
                <input
                  type="url"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onQueueAdd();
                  }}
                  placeholder="https://…/video.mp4 or .m3u8"
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={onQueueAdd}
                  className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium hover:border-[var(--color-accent)]"
                >
                  Add to queue
                </button>
                <p className="text-[10px] leading-snug text-[var(--color-muted)]">
                  http(s) streams OK — including localhost / LAN. Browser must
                  be able to fetch the URL (CORS / mixed content still apply).
                </p>
              </div>
            ) : null}

            <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
              {queue.map((url, i) => {
                const active = i === queueIndex;
                return (
                  <li
                    key={`${i}-${url}`}
                    className={`flex items-start gap-1 rounded-md px-1.5 py-1 text-xs ${
                      active
                        ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                        : "text-[var(--color-text)]"
                    }`}
                  >
                    <button
                      type="button"
                      disabled={!isHost}
                      onClick={() => onQueuePlay(i)}
                      className="min-w-0 flex-1 truncate text-left font-mono disabled:cursor-default"
                      title={url}
                    >
                      {active ? "▶ " : `${i + 1}. `}
                      {shortUrl(url)}
                    </button>
                    {isHost ? (
                      <button
                        type="button"
                        onClick={() => onQueueRemove(i)}
                        className="shrink-0 px-1 text-[var(--color-muted)] hover:text-[var(--color-danger)]"
                        aria-label={`Remove item ${i + 1}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                );
              })}
              {queue.length === 0 ? (
                <li className="text-xs text-[var(--color-muted)]">
                  Queue empty
                </li>
              ) : null}
            </ul>
          </div>

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
                  <span
                    className={m.sessionId === sessionId ? "font-medium" : ""}
                  >
                    {m.nickname}
                    {m.sessionId === sessionId ? " (you)" : ""}
                  </span>
                  {m.isHost ? (
                    <span className="text-xs text-[var(--color-accent)]">
                      host
                    </span>
                  ) : null}
                </li>
              ))}
              {members.length === 0 ? (
                <li className="text-xs text-[var(--color-muted)]">
                  Connecting…
                </li>
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
            queueIndex: playback.queueIndex,
            queue: playback.queue.length,
            host: playback.hostSessionId?.slice(0, 8),
          },
          null,
          2,
        )}
      </pre>
    </details>
  );
}
