import { DurableObject } from "cloudflare:workers";
import {
  MAX_MEMBERS,
  MAX_QUEUE_LENGTH,
  ROOM_IDLE_TTL_MS,
  clientMessageSchema,
  emptyPlaybackState,
  isAllowedVideoUrl,
  normalizePlaybackState,
  type ClientMessage,
  type Member,
  type PlaybackState,
  type ServerMessage,
} from "@vidsync/shared";

type SessionAttachment = {
  sessionId: string;
  nickname: string;
  joinedAtMs: number;
  helloDone: boolean;
};

type StoredRoom = {
  code: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  state: PlaybackState;
};

export class Room extends DurableObject<Env> {
  private sessions = new Map<WebSocket, SessionAttachment>();
  private room: StoredRoom | null = null;
  private lastHeartbeatBroadcastMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();

    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (attachment) {
        this.sessions.set(ws, attachment);
      }
    });

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = (await this.ctx.storage.get<StoredRoom>("room")) ?? null;
      if (stored) {
        stored.state = normalizePlaybackState(stored.state);
        this.room = stored;
      } else {
        this.room = null;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/init")) {
      return this.handleInit(request);
    }

    if (request.method === "GET" && url.pathname.endsWith("/meta")) {
      return this.handleMeta();
    }

    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleInit(request: Request): Promise<Response> {
    let body: { code: string; videoUrl?: string } = { code: "" };
    try {
      body = (await request.json()) as { code: string; videoUrl?: string };
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!body.code) {
      return Response.json({ error: "missing_code" }, { status: 400 });
    }

    const now = Date.now();
    if (!this.room) {
      let state = emptyPlaybackState(now);
      // Optional seed URL into queue (create can also be empty sync group)
      if (body.videoUrl && isAllowedVideoUrl(body.videoUrl)) {
        state = {
          ...state,
          version: 1,
          queue: [body.videoUrl],
          queueIndex: 0,
          videoUrl: body.videoUrl,
          updatedAtMs: now,
          serverAnchorMs: now,
        };
      }
      this.room = {
        code: body.code,
        createdAtMs: now,
        lastActiveAtMs: now,
        state,
      };
      await this.persist();
      await this.scheduleIdleAlarm();
    }

    return Response.json({
      code: this.room.code,
      createdAtMs: this.room.createdAtMs,
      hasVideo: this.room.state.videoUrl != null,
      queueLength: this.room.state.queue.length,
      memberCount: this.sessions.size,
    });
  }

  private handleMeta(): Response {
    if (!this.room) {
      return Response.json({ exists: false }, { status: 404 });
    }
    return Response.json({
      exists: true,
      code: this.room.code,
      createdAtMs: this.room.createdAtMs,
      memberCount: this.liveMemberCount(),
      hasVideo: this.room.state.videoUrl != null,
      queueLength: this.room.state.queue.length,
    });
  }

  private handleWebSocketUpgrade(): Response {
    if (!this.room) {
      return new Response("Room not found", { status: 404 });
    }

    if (this.liveMemberCount() >= MAX_MEMBERS) {
      return new Response("Room full", { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server);

    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const attachment: SessionAttachment = {
      sessionId,
      nickname: `viewer-${sessionId.slice(0, 4)}`,
      joinedAtMs: now,
      helloDone: false,
    };
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);

    void this.touch();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      this.send(ws, {
        type: "error",
        code: "invalid_message",
        message: "Expected JSON text",
      });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.send(ws, {
        type: "error",
        code: "invalid_json",
        message: "Invalid JSON",
      });
      return;
    }

    const parsed = clientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.send(ws, {
        type: "error",
        code: "invalid_message",
        message: parsed.error.issues[0]?.message ?? "Invalid message",
      });
      return;
    }

    const session = this.sessions.get(ws);
    if (!session || !this.room) {
      this.send(ws, {
        type: "error",
        code: "no_session",
        message: "Session missing",
      });
      return;
    }

    await this.handleClientMessage(ws, session, parsed.data);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }

    if (!this.room || !session) {
      await this.scheduleIdleAlarm();
      return;
    }

    let hostChanged = false;
    if (this.room.state.hostSessionId === session.sessionId) {
      const next = this.oldestLiveSession();
      this.room.state = {
        ...this.room.state,
        hostSessionId: next?.sessionId ?? null,
        version: this.room.state.version + 1,
        updatedAtMs: Date.now(),
      };
      hostChanged = true;
      await this.persist();
    }

    if (hostChanged) {
      this.broadcastState();
    }
    this.broadcastMembers();
    await this.scheduleIdleAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
    await this.scheduleIdleAlarm();
  }

  async alarm(): Promise<void> {
    const ttl = this.idleTtlMs();
    if (this.liveMemberCount() > 0) {
      await this.scheduleIdleAlarm();
      return;
    }
    if (!this.room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const idleFor = Date.now() - this.room.lastActiveAtMs;
    if (idleFor >= ttl) {
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(this.room.lastActiveAtMs + ttl);
  }

  private async handleClientMessage(
    ws: WebSocket,
    session: SessionAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (!this.room) return;

    if (msg.type === "hello") {
      if (msg.nickname) {
        session.nickname = msg.nickname;
      }
      session.helloDone = true;
      ws.serializeAttachment(session);
      this.sessions.set(ws, session);

      const now = Date.now();
      if (!this.room.state.hostSessionId) {
        this.room.state = {
          ...this.room.state,
          hostSessionId: session.sessionId,
          version: this.room.state.version + 1,
          updatedAtMs: now,
          serverAnchorMs: now,
        };
        await this.persist();
      }

      const isHost = this.room.state.hostSessionId === session.sessionId;
      this.send(ws, {
        type: "welcome",
        sessionId: session.sessionId,
        isHost,
        state: this.room.state,
        members: this.memberList(),
        serverTimeMs: now,
      });
      this.broadcastMembers();
      await this.touch();
      return;
    }

    if (!session.helloDone) {
      this.send(ws, {
        type: "error",
        code: "hello_required",
        message: "Send hello first",
      });
      return;
    }

    if (msg.type === "set_nickname") {
      session.nickname = msg.nickname;
      ws.serializeAttachment(session);
      this.sessions.set(ws, session);
      this.broadcastMembers();
      await this.touch();
      return;
    }

    const isHost = this.room.state.hostSessionId === session.sessionId;

    if (msg.type === "transfer_host") {
      if (!isHost) {
        this.send(ws, {
          type: "error",
          code: "not_host",
          message: "Only host can transfer",
        });
        return;
      }
      const target = [...this.sessions.values()].find(
        (s) => s.sessionId === msg.targetSessionId && s.helloDone,
      );
      if (!target) {
        this.send(ws, {
          type: "error",
          code: "not_found",
          message: "Target session not found",
        });
        return;
      }
      const now = Date.now();
      this.room.state = {
        ...this.room.state,
        hostSessionId: target.sessionId,
        version: this.room.state.version + 1,
        updatedAtMs: now,
      };
      await this.persist();
      this.broadcastState();
      this.broadcastMembers();
      await this.touch();
      return;
    }

    if (!isHost) {
      this.send(ws, {
        type: "error",
        code: "not_host",
        message: "Only host can control playback",
      });
      return;
    }

    const now = Date.now();

    switch (msg.type) {
      case "set_url": {
        // Compat: add to queue and select as current (play immediately after load)
        if (
          !this.room.state.queue.includes(msg.url) &&
          this.room.state.queue.length >= MAX_QUEUE_LENGTH
        ) {
          this.send(ws, {
            type: "error",
            code: "queue_full",
            message: `Queue is full (max ${MAX_QUEUE_LENGTH})`,
          });
          return;
        }
        this.applySetUrl(msg.url, now);
        break;
      }
      case "queue_add": {
        if (this.room.state.queue.length >= MAX_QUEUE_LENGTH) {
          this.send(ws, {
            type: "error",
            code: "queue_full",
            message: `Queue is full (max ${MAX_QUEUE_LENGTH})`,
          });
          return;
        }
        this.applyQueueAdd(msg.url, now, msg.playIfIdle !== false);
        break;
      }
      case "queue_remove": {
        if (!this.applyQueueRemove(msg.index, now)) {
          this.send(ws, {
            type: "error",
            code: "invalid_index",
            message: "Queue index out of range",
          });
          return;
        }
        break;
      }
      case "queue_play": {
        if (!this.applyQueuePlay(msg.index, now)) {
          this.send(ws, {
            type: "error",
            code: "invalid_index",
            message: "Queue index out of range",
          });
          return;
        }
        break;
      }
      case "queue_clear": {
        this.room.state = {
          ...this.room.state,
          version: this.room.state.version + 1,
          queue: [],
          queueIndex: null,
          videoUrl: null,
          isPlaying: false,
          positionMs: 0,
          serverAnchorMs: now,
          updatedAtMs: now,
        };
        break;
      }
      case "play": {
        if (!this.room.state.videoUrl) {
          this.send(ws, {
            type: "error",
            code: "no_video",
            message: "Queue a video first",
          });
          return;
        }
        this.room.state = {
          ...this.room.state,
          version: this.room.state.version + 1,
          isPlaying: true,
          positionMs: msg.positionMs,
          serverAnchorMs: now,
          updatedAtMs: now,
        };
        break;
      }
      case "pause": {
        this.room.state = {
          ...this.room.state,
          version: this.room.state.version + 1,
          isPlaying: false,
          positionMs: msg.positionMs,
          serverAnchorMs: now,
          updatedAtMs: now,
        };
        break;
      }
      case "seek": {
        this.room.state = {
          ...this.room.state,
          version: this.room.state.version + 1,
          isPlaying: msg.isPlaying,
          positionMs: msg.positionMs,
          serverAnchorMs: now,
          updatedAtMs: now,
        };
        break;
      }
      case "heartbeat": {
        this.room.state = {
          ...this.room.state,
          isPlaying: msg.isPlaying,
          positionMs: msg.positionMs,
          serverAnchorMs: now,
          updatedAtMs: now,
          version: this.room.state.version,
        };
        const since = now - this.lastHeartbeatBroadcastMs;
        if (since >= 4000) {
          this.room.state = {
            ...this.room.state,
            version: this.room.state.version + 1,
          };
          this.lastHeartbeatBroadcastMs = now;
          await this.persist();
          this.broadcastState();
        } else {
          await this.persist();
        }
        await this.touch();
        return;
      }
      default: {
        return;
      }
    }

    await this.persist();
    this.broadcastState();
    await this.touch();
  }

  private applyQueueAdd(
    url: string,
    now: number,
    playIfIdle: boolean,
  ): void {
    if (!this.room) return;
    if (!isAllowedVideoUrl(url)) return;

    const queue = [...this.room.state.queue];
    if (queue.length >= MAX_QUEUE_LENGTH) {
      return;
    }
    queue.push(url);

    const idle =
      this.room.state.videoUrl == null || this.room.state.queueIndex == null;
    let queueIndex = this.room.state.queueIndex;
    let videoUrl = this.room.state.videoUrl;
    let positionMs = this.room.state.positionMs;
    let isPlaying = this.room.state.isPlaying;

    if (idle && playIfIdle) {
      queueIndex = queue.length - 1;
      videoUrl = url;
      positionMs = 0;
      isPlaying = false;
    }

    this.room.state = {
      ...this.room.state,
      version: this.room.state.version + 1,
      queue,
      queueIndex,
      videoUrl,
      positionMs,
      isPlaying,
      serverAnchorMs: now,
      updatedAtMs: now,
    };
  }

  /** Add URL if missing, always select it as current (reset position). */
  private applySetUrl(url: string, now: number): void {
    if (!this.room) return;
    if (!isAllowedVideoUrl(url)) return;

    const queue = [...this.room.state.queue];
    let index = queue.indexOf(url);
    if (index < 0) {
      if (queue.length >= MAX_QUEUE_LENGTH) return;
      queue.push(url);
      index = queue.length - 1;
    }

    this.room.state = {
      ...this.room.state,
      version: this.room.state.version + 1,
      queue,
      queueIndex: index,
      videoUrl: url,
      isPlaying: false,
      positionMs: 0,
      serverAnchorMs: now,
      updatedAtMs: now,
    };
  }

  private applyQueueRemove(index: number, now: number): boolean {
    if (!this.room) return false;
    const queue = [...this.room.state.queue];
    if (index < 0 || index >= queue.length) return false;

    queue.splice(index, 1);

    let queueIndex = this.room.state.queueIndex;
    let videoUrl = this.room.state.videoUrl;
    let positionMs = this.room.state.positionMs;
    let isPlaying = this.room.state.isPlaying;

    if (queue.length === 0) {
      queueIndex = null;
      videoUrl = null;
      positionMs = 0;
      isPlaying = false;
    } else if (queueIndex != null) {
      if (index === queueIndex) {
        // Removed current → stay on same index (next item) or clamp
        queueIndex = Math.min(index, queue.length - 1);
        videoUrl = queue[queueIndex] ?? null;
        positionMs = 0;
        isPlaying = false;
      } else if (index < queueIndex) {
        queueIndex = queueIndex - 1;
      }
    }

    this.room.state = {
      ...this.room.state,
      version: this.room.state.version + 1,
      queue,
      queueIndex,
      videoUrl,
      positionMs,
      isPlaying,
      serverAnchorMs: now,
      updatedAtMs: now,
    };
    return true;
  }

  private applyQueuePlay(index: number, now: number): boolean {
    if (!this.room) return false;
    const url = this.room.state.queue[index];
    if (url == null) return false;

    this.room.state = {
      ...this.room.state,
      version: this.room.state.version + 1,
      queueIndex: index,
      videoUrl: url,
      isPlaying: false,
      positionMs: 0,
      serverAnchorMs: now,
      updatedAtMs: now,
    };
    return true;
  }

  private broadcastState(): void {
    if (!this.room) return;
    const serverTimeMs = Date.now();
    const msg: ServerMessage = {
      type: "state",
      state: this.room.state,
      serverTimeMs,
    };
    this.broadcast(msg);
  }

  private broadcastMembers(): void {
    const msg: ServerMessage = {
      type: "members",
      members: this.memberList(),
      serverTimeMs: Date.now(),
    };
    this.broadcast(msg);
  }

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const [ws, session] of this.sessions) {
      if (!session.helloDone) continue;
      try {
        ws.send(text);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.sessions.delete(ws);
    }
  }

  private memberList(): Member[] {
    const hostId = this.room?.state.hostSessionId ?? null;
    const list: Member[] = [];
    for (const session of this.sessions.values()) {
      if (!session.helloDone) continue;
      list.push({
        sessionId: session.sessionId,
        nickname: session.nickname,
        isHost: session.sessionId === hostId,
      });
    }
    list.sort((a, b) => a.nickname.localeCompare(b.nickname));
    return list;
  }

  private liveMemberCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.helloDone) n++;
    }
    return Math.max(n, this.sessions.size);
  }

  private oldestLiveSession(): SessionAttachment | null {
    let best: SessionAttachment | null = null;
    for (const s of this.sessions.values()) {
      if (!s.helloDone) continue;
      if (!best || s.joinedAtMs < best.joinedAtMs) best = s;
    }
    return best;
  }

  private async persist(): Promise<void> {
    if (!this.room) return;
    await this.ctx.storage.put("room", this.room);
  }

  private async touch(): Promise<void> {
    if (!this.room) return;
    this.room.lastActiveAtMs = Date.now();
    await this.persist();
    await this.scheduleIdleAlarm();
  }

  private idleTtlMs(): number {
    const raw = this.env.ROOM_IDLE_TTL_MS;
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return ROOM_IDLE_TTL_MS;
  }

  private async scheduleIdleAlarm(): Promise<void> {
    if (this.liveMemberCount() > 0) {
      return;
    }
    if (!this.room) return;
    const when = this.room.lastActiveAtMs + this.idleTtlMs();
    await this.ctx.storage.setAlarm(when);
  }
}
