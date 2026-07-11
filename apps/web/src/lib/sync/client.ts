import {
  type ChatMessage,
  type ClientMessage,
  type Member,
  type PlaybackState,
  type ServerMessage,
  expectedPositionMs,
  serverMessageSchema,
} from "@vidsync/shared";

export type ConnState = "idle" | "connecting" | "open" | "closed" | "error";

export type SyncClientHandlers = {
  onConn: (state: ConnState) => void;
  onWelcome: (payload: {
    sessionId: string;
    isHost: boolean;
    state: PlaybackState;
    members: Member[];
    serverTimeMs: number;
  }) => void;
  onState: (state: PlaybackState, serverTimeMs: number) => void;
  onMembers: (members: Member[]) => void;
  onChat: (message: ChatMessage) => void;
  onError: (code: string, message: string) => void;
  onClock: (serverTimeMs: number, localTimeMs: number) => void;
};

export class SyncClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nickname: string;
  private readonly url: string;
  private readonly handlers: SyncClientHandlers;

  constructor(url: string, nickname: string, handlers: SyncClientHandlers) {
    this.url = url;
    this.nickname = nickname;
    this.handlers = handlers;
  }

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, "bye");
    this.ws = null;
    this.handlers.onConn("closed");
  }

  setNickname(nickname: string): void {
    this.nickname = nickname;
    this.send({ type: "set_nickname", nickname });
  }

  sendChat(text: string): void {
    this.send({ type: "chat", text });
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private openSocket(): void {
    this.handlers.onConn("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onConn("open");
      this.send({
        type: "hello",
        nickname: this.nickname,
        clientTimeMs: Date.now(),
      });
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (ev.data === "pong") return;

      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }

      const parsed = serverMessageSchema.safeParse(raw);
      if (!parsed.success) return;

      const msg: ServerMessage = parsed.data;
      const local = Date.now();

      switch (msg.type) {
        case "welcome":
          this.handlers.onClock(msg.serverTimeMs, local);
          this.handlers.onWelcome({
            sessionId: msg.sessionId,
            isHost: msg.isHost,
            state: msg.state,
            members: msg.members,
            serverTimeMs: msg.serverTimeMs,
          });
          break;
        case "state":
          this.handlers.onClock(msg.serverTimeMs, local);
          this.handlers.onState(msg.state, msg.serverTimeMs);
          break;
        case "members":
          this.handlers.onClock(msg.serverTimeMs, local);
          this.handlers.onMembers(msg.members);
          break;
        case "chat":
          this.handlers.onChat(msg.message);
          break;
        case "error":
          this.handlers.onError(msg.code, msg.message);
          break;
      }
    };

    ws.onerror = () => {
      this.handlers.onConn("error");
    };

    ws.onclose = () => {
      this.handlers.onConn("closed");
      this.ws = null;
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(10_000, 500 * 2 ** attempt);
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }
}

export function applyDrift(
  video: HTMLVideoElement,
  state: PlaybackState,
  clockOffsetMs: number,
  opts?: { hardMs?: number; softMs?: number },
): void {
  const hardMs = opts?.hardMs ?? 400;
  const softMs = opts?.softMs ?? 150;
  const nowServer = Date.now() + clockOffsetMs;
  const targetMs = expectedPositionMs(state, nowServer);
  const currentMs = video.currentTime * 1000;
  const drift = targetMs - currentMs;

  if (Math.abs(drift) >= hardMs) {
    video.currentTime = targetMs / 1000;
    video.playbackRate = 1;
    return;
  }

  if (Math.abs(drift) >= softMs) {
    video.playbackRate = drift > 0 ? 1.04 : 0.96;
    return;
  }

  if (video.playbackRate !== 1) {
    video.playbackRate = 1;
  }
}
