import { DurableObject } from "cloudflare:workers";
import {
  CHAT_COOLDOWN_MS,
  EMPTY_ROOM_GRACE_MS,
  HOST_RECLAIM_MS,
  MAX_MEMBERS,
  MAX_QUEUE_LENGTH,
  clientMessageSchema,
  emptyPlaybackState,
  expectedPositionMs,
  isAllowedVideoUrl,
  normalizePlaybackState,
  type ClientMessage,
  type Member,
  type PlaybackState,
  type ServerMessage,
} from "@vidsync/shared";

/** Debounce DO storage writes for lastActiveAtMs (10-min idle only needs coarse grain). */
const TOUCH_PERSIST_MS = 60_000;
/** Kick sockets that never completed hello (bypass MAX_MEMBERS otherwise). */
const HELLO_TIMEOUT_MS = 30_000;

type SessionAttachment = {
  sessionId: string;
  nickname: string;
  joinedAtMs: number;
  helloDone: boolean;
  lastChatMs?: number;
  /** windows | linux | macos | web | unknown */
  platform?: string;
  /**
   * Desktop process id from hello. Same key on rejoin/reconnect → kick old
   * sockets so the people list doesn't stack duplicates.
   */
  clientKey?: string;
  /** Last client-measured RTT to this DO (ms). */
  rttMs?: number;
  /** Last time we broadcast members because rtt changed. */
  lastRttBroadcastMs?: number;
};

type StoredRoom = {
  code: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  /** Last host application message (heartbeat, play, pause, …). */
  lastHostActivityAtMs: number;
  /** When designated host socket disappeared (null while host live). */
  hostGoneAtMs: number | null;
  /**
   * clientKey of the designated host process. Instant reclaim on reconnect
   * only allowed when hello.clientKey matches (prevents peer steal during blip).
   */
  hostClientKey: string | null;
  state: PlaybackState;
};

export class Room extends DurableObject<Env> {
  private sessions = new Map<WebSocket, SessionAttachment>();
  private room: StoredRoom | null = null;
  private lastHeartbeatBroadcastMs = 0;
  /** Last time touch() wrote to storage (in-memory; resets on DO cold start). */
  private lastTouchWriteMs = 0;

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
        if (!stored.lastHostActivityAtMs) {
          stored.lastHostActivityAtMs =
            stored.lastActiveAtMs || stored.createdAtMs || Date.now();
        }
        if (stored.hostGoneAtMs === undefined) {
          stored.hostGoneAtMs = null;
        }
        if (stored.hostClientKey === undefined) {
          stored.hostClientKey = null;
        }
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
    // Collision: existing room must not silently merge two parties.
    // Create path treats 409 as retry signal for a new code.
    if (this.room) {
      return Response.json(
        { error: "room_exists", code: this.room.code },
        { status: 409 },
      );
    }

    let state = emptyPlaybackState(now);
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
      lastHostActivityAtMs: now,
      hostGoneAtMs: null,
      hostClientKey: null,
      state,
    };
    await this.persist();
    // Arm empty-room wipe even if nobody ever joins (orphan DO storage).
    await this.scheduleMaintenanceAlarm();

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
    // Arm hello-timeout sweep for silent sockets.
    void this.scheduleMaintenanceAlarm();

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
    const session = this.sessions.get(ws) ?? this.attachmentOf(ws);
    this.sessions.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }

    if (!this.room) {
      await this.scheduleMaintenanceAlarm();
      return;
    }

    const wasHost =
      !!session && this.room.state.hostSessionId === session.sessionId;

    // NEVER dissolve while peers may still be connected. Mark host gone for
    // reclaim/promote; empty wipe only when zero sockets after long grace.
    if (wasHost) {
      this.room.hostGoneAtMs = Date.now();
      await this.persist();
      this.broadcastMembers();
    } else if (session) {
      this.broadcastMembers();
    }

    await this.scheduleMaintenanceAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    // Same path as close — DO often fires error then close
    const session = this.sessions.get(ws) ?? this.attachmentOf(ws);
    this.sessions.delete(ws);
    if (this.room && session?.sessionId === this.room.state.hostSessionId) {
      this.room.hostGoneAtMs = Date.now();
      await this.persist();
    }
    await this.scheduleMaintenanceAlarm();
  }

  async alarm(): Promise<void> {
    this.rebuildSessionsFromHibernation();
    const now = Date.now();

    // Kick silent pre-hello sockets (open WS, never join — bypass member cap).
    await this.kickStaleHellos(now);

    // ——— Empty room: only wipe when NO sockets for a long grace ———
    if (this.openConnectionCount() === 0) {
      if (!this.room) {
        await this.ctx.storage.deleteAll();
        return;
      }
      const idleFor = now - (this.room.lastActiveAtMs || 0);
      if (idleFor >= this.emptyGraceMs()) {
        this.room = null;
        this.sessions.clear();
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.ctx.storage.setAlarm(
        (this.room.lastActiveAtMs || now) + this.emptyGraceMs(),
      );
      return;
    }

    // ——— Anyone connected: room MUST stay alive ———
    if (!this.room) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    if (this.isHostLive()) {
      this.room.hostGoneAtMs = null;
      await this.persist();
      // No dissolve timer while populated — only re-check if host later drops
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Host socket gone, peers remain → wait for reclaim, then promote
    const goneAt =
      this.room.hostGoneAtMs ??
      this.room.lastHostActivityAtMs ??
      now;
    if (this.room.hostGoneAtMs == null) {
      this.room.hostGoneAtMs = goneAt;
      await this.persist();
    }

    if (now - goneAt >= this.hostReclaimMs()) {
      const promoted = await this.promoteOldestHost();
      if (promoted) {
        this.broadcastState();
        this.broadcastMembers();
      }
      // Stay alive either way
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(goneAt + this.hostReclaimMs());
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
      if (msg.platform) {
        session.platform = msg.platform;
      }
      if (msg.clientKey) {
        session.clientKey = msg.clientKey;
      }
      session.helloDone = true;
      ws.serializeAttachment(session);
      this.sessions.set(ws, session);

      const now = Date.now();

      // Drop ghost sockets from leave/rejoin + auto-reconnect races.
      // Must run BEFORE isHostLive — rebuild used to re-add half-closed ghosts.
      await this.pruneDeadSockets();
      if (session.clientKey) {
        await this.kickSessionsWithClientKey(ws, session);
      }
      // Pre-clientKey ghosts (or failed attachment): same nick + platform, no key
      await this.kickOrphanNickTwins(ws, session);

      // Claim host only when vacant or this process is the prior host (clientKey).
      // Anyone else waits for HOST_RECLAIM_MS alarm promote — prevents peer steal
      // when host WS blips and everyone reconnects with the same backoff.
      if (!this.room.state.hostSessionId || !this.isHostLive()) {
        const sameHostProcess =
          !!session.clientKey &&
          !!this.room.hostClientKey &&
          session.clientKey === this.room.hostClientKey;
        const vacant = !this.room.state.hostSessionId;
        if (vacant || sameHostProcess) {
          // Extrapolate playing timeline before re-anchoring so reconnect
          // does not rewind the whole room by the outage duration.
          const positionMs = expectedPositionMs(this.room.state, now);
          this.room.state = {
            ...this.room.state,
            hostSessionId: session.sessionId,
            positionMs,
            version: this.room.state.version + 1,
            updatedAtMs: now,
            serverAnchorMs: now,
          };
          if (session.clientKey) {
            this.room.hostClientKey = session.clientKey;
          }
          this.room.lastHostActivityAtMs = now;
          this.room.hostGoneAtMs = null;
          await this.persist();
        }
        // else: host gone but different clientKey — stay follower until alarm
      }

      const isHost = this.room.state.hostSessionId === session.sessionId;
      if (isHost) {
        this.room.lastHostActivityAtMs = now;
        this.room.hostGoneAtMs = null;
        if (session.clientKey) {
          this.room.hostClientKey = session.clientKey;
        }
        await this.persist();
      }

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
      await this.scheduleMaintenanceAlarm();
      return;
    }

    // Ping is allowed only after hello (need a listed member for rtt).
    if (msg.type === "ping") {
      if (!session.helloDone) {
        this.send(ws, {
          type: "error",
          code: "hello_required",
          message: "Send hello first",
        });
        return;
      }
      const now = Date.now();
      const prev = session.rttMs;
      if (typeof msg.rttMs === "number" && Number.isFinite(msg.rttMs)) {
        session.rttMs = Math.max(0, Math.min(60_000, Math.round(msg.rttMs)));
      }
      ws.serializeAttachment(session);
      this.sessions.set(ws, session);

      this.send(ws, {
        type: "pong",
        clientTimeMs: msg.clientTimeMs,
        serverTimeMs: now,
      });

      // Publish ping to room when it moves meaningfully (avoid spam)
      const changed =
        session.rttMs != null &&
        (prev == null || Math.abs(session.rttMs - prev) >= 12);
      const due =
        !session.lastRttBroadcastMs ||
        now - session.lastRttBroadcastMs >= 8_000;
      if (session.rttMs != null && (changed || due)) {
        session.lastRttBroadcastMs = now;
        ws.serializeAttachment(session);
        this.sessions.set(ws, session);
        this.broadcastMembers();
      }
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

    if (msg.type === "chat") {
      const now = Date.now();
      const last = session.lastChatMs ?? 0;
      if (now - last < CHAT_COOLDOWN_MS) {
        this.send(ws, {
          type: "error",
          code: "chat_slow_down",
          message: "Slow down a bit",
        });
        return;
      }
      session.lastChatMs = now;
      ws.serializeAttachment(session);
      this.sessions.set(ws, session);

      const chatMsg: ServerMessage = {
        type: "chat",
        message: {
          id: crypto.randomUUID(),
          sessionId: session.sessionId,
          nickname: session.nickname,
          text: msg.text,
          serverTimeMs: now,
        },
      };
      this.broadcast(chatMsg);
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
      this.room.lastHostActivityAtMs = now;
      this.room.hostClientKey = target.clientKey ?? null;
      await this.persist();
      this.broadcastState();
      this.broadcastMembers();
      await this.touch();
      await this.scheduleMaintenanceAlarm();
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
    // Any host control/heartbeat counts as activity (keeps room alive)
    this.room.lastHostActivityAtMs = now;

    switch (msg.type) {
      case "set_url": {
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
        // Heartbeats update position without always bumping version —
        // high-frequency version++ caused clients to re-seek / re-paint (flicker).
        this.room.state = {
          ...this.room.state,
          isPlaying: msg.isPlaying,
          positionMs: msg.positionMs,
          serverAnchorMs: now,
          updatedAtMs: now,
        };
        this.room.lastHostActivityAtMs = now;
        const since = now - this.lastHeartbeatBroadcastMs;
        // Broadcast about every 8s for follower drift correction (+ single persist)
        if (since >= 8000) {
          this.room.state = {
            ...this.room.state,
            version: this.room.state.version + 1,
          };
          this.lastHeartbeatBroadcastMs = now;
          await this.persist();
          this.broadcastState();
        }
        // No mid-interval full-room persist — touch() debounces lastActiveAtMs.
        await this.touch();
        await this.scheduleMaintenanceAlarm();
        return;
      }
      default: {
        return;
      }
    }

    await this.persist();
    this.broadcastState();
    await this.touch();
    await this.scheduleMaintenanceAlarm();
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
      if (!this.socketIsOpen(ws)) {
        this.sessions.delete(ws);
        continue;
      }
      try {
        ws.send(text);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (!this.socketIsOpen(ws)) {
      this.sessions.delete(ws);
      return;
    }
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.sessions.delete(ws);
    }
  }

  private memberList(): Member[] {
    this.rebuildSessionsFromHibernation();
    const hostId = this.room?.state.hostSessionId ?? null;

    // Prefer one row per clientKey (latest join wins). Hides reconnect ghosts
    // even if close() hasn't finished yet on the DO.
    const bestByKey = new Map<string, SessionAttachment>();
    const noKey: SessionAttachment[] = [];
    for (const session of this.sessions.values()) {
      if (!session.helloDone) continue;
      if (session.clientKey) {
        const prev = bestByKey.get(session.clientKey);
        if (!prev || session.joinedAtMs >= prev.joinedAtMs) {
          bestByKey.set(session.clientKey, session);
        }
      } else {
        noKey.push(session);
      }
    }

    const list: Member[] = [];
    const push = (session: SessionAttachment) => {
      list.push({
        sessionId: session.sessionId,
        nickname: session.nickname,
        isHost: session.sessionId === hostId,
        ...(session.platform
          ? {
              platform: session.platform as Member["platform"],
            }
          : {}),
        ...(session.rttMs != null && session.rttMs >= 0
          ? { rttMs: session.rttMs }
          : {}),
      });
    };
    for (const s of bestByKey.values()) push(s);
    for (const s of noKey) push(s);
    list.sort((a, b) => a.nickname.localeCompare(b.nickname));
    return list;
  }

  private socketIsOpen(ws: WebSocket): boolean {
    // 1 = OPEN. CLOSING/CLOSED ghosts must not re-enter the member map.
    try {
      return ws.readyState === 1;
    } catch {
      return false;
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    this.sessions.delete(ws);
    try {
      if (this.socketIsOpen(ws) || ws.readyState === 0) {
        ws.close(code, reason);
      }
    } catch {
      // already closed
    }
  }

  /**
   * Close every other socket that presented the same clientKey. Transfer host
   * ownership to the surviving session when the ghost was host.
   */
  private async kickSessionsWithClientKey(
    keep: WebSocket,
    keepSession: SessionAttachment,
  ): Promise<void> {
    if (!this.room || !keepSession.clientKey) return;
    this.rebuildSessionsFromHibernation();

    const key = keepSession.clientKey;
    const doomed: WebSocket[] = [];
    let hostWasGhost = false;

    for (const [ows, os] of this.sessions) {
      if (ows === keep) continue;
      if (os.clientKey !== key) continue;
      if (this.room.state.hostSessionId === os.sessionId) {
        hostWasGhost = true;
      }
      doomed.push(ows);
    }

    for (const ows of this.ctx.getWebSockets()) {
      if (ows === keep || doomed.includes(ows)) continue;
      if (!this.socketIsOpen(ows)) continue;
      const att = this.attachmentOf(ows);
      if (!att || att.clientKey !== key) continue;
      if (this.room.state.hostSessionId === att.sessionId) {
        hostWasGhost = true;
      }
      doomed.push(ows);
    }

    for (const ows of doomed) {
      this.closeSocket(ows, 4000, "replaced");
    }

    if (hostWasGhost || doomed.length > 0) {
      if (hostWasGhost) {
        this.room.state = {
          ...this.room.state,
          hostSessionId: keepSession.sessionId,
          version: this.room.state.version + 1,
          updatedAtMs: Date.now(),
        };
        this.room.hostGoneAtMs = null;
        this.room.lastHostActivityAtMs = Date.now();
      }
      await this.persist();
    }
  }

  /**
   * Kick older sockets with the same nickname+platform that never sent a
   * clientKey (pre-fix ghosts). Avoids stacking "Strange" rows after rejoin
   * when only the new socket has a key.
   */
  private async kickOrphanNickTwins(
    keep: WebSocket,
    keepSession: SessionAttachment,
  ): Promise<void> {
    if (!this.room) return;
    this.rebuildSessionsFromHibernation();
    const nick = keepSession.nickname.trim().toLowerCase();
    const plat = keepSession.platform ?? "";
    if (!nick) return;

    const doomed: WebSocket[] = [];
    let hostWasGhost = false;

    for (const [ows, os] of this.sessions) {
      if (ows === keep) continue;
      // Only orphans — never kick another real clientKey holder (2nd device)
      if (os.clientKey) continue;
      if (os.nickname.trim().toLowerCase() !== nick) continue;
      if ((os.platform ?? "") !== plat) continue;
      if (this.room.state.hostSessionId === os.sessionId) hostWasGhost = true;
      doomed.push(ows);
    }

    for (const ows of doomed) {
      this.closeSocket(ows, 4000, "orphan_replaced");
    }

    if (hostWasGhost && doomed.length > 0) {
      this.room.state = {
        ...this.room.state,
        hostSessionId: keepSession.sessionId,
        version: this.room.state.version + 1,
        updatedAtMs: Date.now(),
      };
      this.room.hostGoneAtMs = null;
      this.room.lastHostActivityAtMs = Date.now();
      await this.persist();
    }
  }

  /** Drop CLOSING/CLOSED entries and map junk so ghosts don't resurrect. */
  private async pruneDeadSockets(): Promise<void> {
    this.rebuildSessionsFromHibernation();
    const dead: WebSocket[] = [];
    for (const ws of this.sessions.keys()) {
      if (!this.socketIsOpen(ws)) dead.push(ws);
    }
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.socketIsOpen(ws) && this.sessions.has(ws)) {
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      this.sessions.delete(ws);
    }
  }

  private liveMemberCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.helloDone) n++;
    }
    // Don't use sessions.size — half-open ghosts inflated "room full"
    return n;
  }

  /**
   * Pull hibernation sockets back into the in-memory map (DO wake).
   * Skips non-OPEN sockets so close()/kick can't be undone by rebuild.
   */
  private rebuildSessionsFromHibernation(): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.socketIsOpen(ws)) {
        this.sessions.delete(ws);
        continue;
      }
      if (this.sessions.has(ws)) continue;
      const att = this.attachmentOf(ws);
      if (att) this.sessions.set(ws, att);
    }
  }

  private attachmentOf(ws: WebSocket): SessionAttachment | null {
    try {
      return ws.deserializeAttachment() as SessionAttachment | null;
    } catch {
      return null;
    }
  }

  /** True if the designated host still has a live hello'd socket. */
  private isHostLive(): boolean {
    this.rebuildSessionsFromHibernation();
    const hostId = this.room?.state.hostSessionId;
    if (!hostId) return false;
    for (const session of this.sessions.values()) {
      if (session.sessionId === hostId && session.helloDone) return true;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (att?.sessionId === hostId && att.helloDone) return true;
    }
    return false;
  }

  /** Oldest hello'd member becomes host. Returns true if changed. */
  private async promoteOldestHost(): Promise<boolean> {
    if (!this.room) return false;
    this.rebuildSessionsFromHibernation();
    let best: SessionAttachment | null = null;
    for (const s of this.sessions.values()) {
      if (!s.helloDone) continue;
      if (!best || s.joinedAtMs < best.joinedAtMs) best = s;
    }
    if (!best) return false;
    if (this.room.state.hostSessionId === best.sessionId) {
      this.room.hostGoneAtMs = null;
      this.room.lastHostActivityAtMs = Date.now();
      if (best.clientKey) this.room.hostClientKey = best.clientKey;
      await this.persist();
      return false;
    }
    const now = Date.now();
    // Extrapolate before promote so new host doesn't inherit a frozen anchor.
    const positionMs = expectedPositionMs(this.room.state, now);
    this.room.state = {
      ...this.room.state,
      hostSessionId: best.sessionId,
      positionMs,
      serverAnchorMs: now,
      version: this.room.state.version + 1,
      updatedAtMs: now,
    };
    this.room.lastHostActivityAtMs = now;
    this.room.hostGoneAtMs = null;
    this.room.hostClientKey = best.clientKey ?? null;
    await this.persist();
    return true;
  }

  /** Close sockets that never completed hello within HELLO_TIMEOUT_MS. */
  private async kickStaleHellos(now: number): Promise<void> {
    const sockets = new Set<WebSocket>([
      ...this.sessions.keys(),
      ...this.ctx.getWebSockets(),
    ]);
    for (const ws of sockets) {
      const att = this.sessions.get(ws) ?? this.attachmentOf(ws);
      if (!att || att.helloDone) continue;
      if (now - att.joinedAtMs < HELLO_TIMEOUT_MS) continue;
      this.sessions.delete(ws);
      try {
        ws.close(4001, "hello_timeout");
      } catch {
        /* */
      }
    }
  }

  private async dissolveRoom(
    reason: "host_left" | "empty" | "destroyed",
    message: string,
  ): Promise<void> {
    const msg: ServerMessage = {
      type: "room_closed",
      reason,
      message,
      serverTimeMs: Date.now(),
    };
    const text = JSON.stringify(msg);

    const sockets = new Set<WebSocket>([
      ...this.sessions.keys(),
      ...this.ctx.getWebSockets(),
    ]);

    for (const sock of sockets) {
      try {
        sock.send(text);
      } catch {
        /* */
      }
      try {
        sock.close(4000, reason);
      } catch {
        /* */
      }
    }

    this.sessions.clear();
    this.room = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  private async persist(): Promise<void> {
    if (!this.room) return;
    await this.ctx.storage.put("room", this.room);
  }

  private async touch(): Promise<void> {
    if (!this.room) return;
    const now = Date.now();
    this.room.lastActiveAtMs = now;
    // lastActiveAtMs only matters at 10-min empty-grace granularity —
    // writing full StoredRoom on every 2s ping is pure DO cost.
    if (now - this.lastTouchWriteMs < TOUCH_PERSIST_MS) return;
    this.lastTouchWriteMs = now;
    await this.persist();
  }

  private openConnectionCount(): number {
    return this.ctx.getWebSockets().length;
  }

  private emptyGraceMs(): number {
    const raw = this.env.ROOM_IDLE_TTL_MS;
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return EMPTY_ROOM_GRACE_MS;
  }

  private hostReclaimMs(): number {
    const raw = this.env.HOST_RECLAIM_MS ?? this.env.HOST_STALE_MS;
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return HOST_RECLAIM_MS;
  }

  /**
   * Schedule empty wipe OR host reclaim. Never schedules “dissolve while occupied”.
   */
  private async scheduleMaintenanceAlarm(): Promise<void> {
    if (!this.room) {
      if (this.openConnectionCount() === 0) {
        await this.ctx.storage.deleteAll();
      }
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    this.rebuildSessionsFromHibernation();

    if (this.openConnectionCount() === 0) {
      await this.ctx.storage.setAlarm(
        (this.room.lastActiveAtMs || now) + this.emptyGraceMs(),
      );
      return;
    }

    const pendingHello = this.hasPendingHello();
    const helloSweepAt = pendingHello ? now + HELLO_TIMEOUT_MS : null;

    if (!this.isHostLive()) {
      const goneAt =
        this.room.hostGoneAtMs ?? this.room.lastHostActivityAtMs ?? now;
      if (this.room.hostGoneAtMs == null) {
        this.room.hostGoneAtMs = goneAt;
        await this.persist();
      }
      const reclaimAt = goneAt + this.hostReclaimMs();
      const at =
        helloSweepAt != null ? Math.min(reclaimAt, helloSweepAt) : reclaimAt;
      await this.ctx.storage.setAlarm(at);
      return;
    }

    // Occupied + host live → sweep silent hellos only when any exist
    if (helloSweepAt != null) {
      await this.ctx.storage.setAlarm(helloSweepAt);
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }

  private hasPendingHello(): boolean {
    for (const s of this.sessions.values()) {
      if (!s.helloDone) return true;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (att && !att.helloDone) return true;
    }
    return false;
  }
}
