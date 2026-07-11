import { z } from "zod";

export const ROOM_CODE_LENGTH = 8;
export const MAX_MEMBERS = 20;
export const MAX_NICKNAME_LENGTH = 24;
export const MAX_VIDEO_URL_LENGTH = 2048;
export const MAX_QUEUE_LENGTH = 50;
export const MAX_CHAT_LENGTH = 280;
export const HOST_HEARTBEAT_MS = 5000;
/**
 * After the last client disconnects (no host-leave case), wait this long
 * before wiping. Host leave closes the room immediately.
 */
export const EMPTY_ROOM_GRACE_MS = 5_000;
/** @deprecated use EMPTY_ROOM_GRACE_MS */
export const ROOM_IDLE_TTL_MS = EMPTY_ROOM_GRACE_MS;
/** Min ms between chat messages per session (stateless flood control). */
export const CHAT_COOLDOWN_MS = 400;

/** Crockford base32 alphabet (no I, L, O, U). */
export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const roomCodeSchema = z
  .string()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`));

export const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NICKNAME_LENGTH)
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ""));

/**
 * Stream URLs: http(s) only. Localhost / LAN / private hosts allowed
 * (home NAS, local media servers). Blocks non-http schemes.
 */
export function isAllowedVideoUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_VIDEO_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (!url.hostname) return false;
  return true;
}

export const videoUrlSchema = z
  .string()
  .max(MAX_VIDEO_URL_LENGTH)
  .refine(isAllowedVideoUrl, {
    message: "Video URL must be http(s) (e.g. https://… or http://localhost/…).",
  });

export const playbackStateSchema = z.object({
  version: z.number().int().nonnegative(),
  videoUrl: z.string().nullable(),
  isPlaying: z.boolean(),
  positionMs: z.number().nonnegative(),
  serverAnchorMs: z.number().int().nonnegative(),
  hostSessionId: z.string().nullable(),
  updatedAtMs: z.number().int().nonnegative(),
  /** Ordered playlist of http(s) stream URLs (public or LAN). */
  queue: z.array(z.string()).default([]),
  /** Index into queue for current item, or null if nothing selected. */
  queueIndex: z.number().int().nonnegative().nullable().default(null),
});

export type PlaybackState = z.infer<typeof playbackStateSchema>;

export const memberSchema = z.object({
  sessionId: z.string(),
  nickname: z.string(),
  isHost: z.boolean(),
});

export type Member = z.infer<typeof memberSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    nickname: nicknameSchema.optional(),
    clientTimeMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("set_url"),
    url: videoUrlSchema,
  }),
  z.object({
    type: z.literal("queue_add"),
    url: videoUrlSchema,
    /** If true (default), start this item when nothing is playing yet. */
    playIfIdle: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("queue_remove"),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("queue_play"),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("queue_clear"),
  }),
  z.object({
    type: z.literal("play"),
    positionMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("pause"),
    positionMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("seek"),
    positionMs: z.number().nonnegative(),
    isPlaying: z.boolean(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    positionMs: z.number().nonnegative(),
    isPlaying: z.boolean(),
  }),
  z.object({
    type: z.literal("transfer_host"),
    targetSessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("set_nickname"),
    nickname: nicknameSchema,
  }),
  z.object({
    type: z.literal("chat"),
    text: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CHAT_LENGTH)
      .transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  nickname: z.string(),
  text: z.string(),
  serverTimeMs: z.number().int().nonnegative(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    sessionId: z.string(),
    isHost: z.boolean(),
    state: playbackStateSchema,
    members: z.array(memberSchema),
    serverTimeMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("state"),
    state: playbackStateSchema,
    serverTimeMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("members"),
    members: z.array(memberSchema),
    serverTimeMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("chat"),
    message: chatMessageSchema,
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
  /** Room is gone — clients must leave (host disconnected). */
  z.object({
    type: z.literal("room_closed"),
    reason: z.enum(["host_left", "empty", "destroyed"]),
    message: z.string(),
    serverTimeMs: z.number().int().nonnegative(),
  }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const createRoomBodySchema = z.object({
  /** Optional seed URL — room can also be created empty (sync group only). */
  videoUrl: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    videoUrlSchema.optional(),
  ),
  /**
   * Cloudflare Turnstile response token from the web widget.
   * Optional when the client is the desktop app (`X-VidSync-Client: desktop/…`).
   */
  turnstileToken: z.string().min(1).max(2048).optional(),
});

export type CreateRoomBody = z.infer<typeof createRoomBodySchema>;

export function expectedPositionMs(
  state: Pick<PlaybackState, "isPlaying" | "positionMs" | "serverAnchorMs">,
  nowMs: number,
): number {
  if (!state.isPlaying) return state.positionMs;
  return Math.max(0, state.positionMs + (nowMs - state.serverAnchorMs));
}

export function emptyPlaybackState(nowMs: number): PlaybackState {
  return {
    version: 0,
    videoUrl: null,
    isPlaying: false,
    positionMs: 0,
    serverAnchorMs: nowMs,
    hostSessionId: null,
    updatedAtMs: nowMs,
    queue: [],
    queueIndex: null,
  };
}

/** Backfill queue fields for rooms stored before queue existed. */
export function normalizePlaybackState(
  raw: Partial<PlaybackState> & {
    version?: number;
    videoUrl?: string | null;
  },
  nowMs: number = Date.now(),
): PlaybackState {
  const base = emptyPlaybackState(nowMs);
  let queue = Array.isArray(raw.queue)
    ? raw.queue.filter((u): u is string => typeof u === "string" && isAllowedVideoUrl(u))
    : [];
  if (queue.length === 0 && raw.videoUrl && isAllowedVideoUrl(raw.videoUrl)) {
    queue = [raw.videoUrl];
  }
  queue = queue.slice(0, MAX_QUEUE_LENGTH);

  let queueIndex: number | null =
    typeof raw.queueIndex === "number" && Number.isInteger(raw.queueIndex)
      ? raw.queueIndex
      : null;
  if (queueIndex != null && (queueIndex < 0 || queueIndex >= queue.length)) {
    queueIndex = queue.length > 0 ? 0 : null;
  }
  if (queueIndex == null && queue.length > 0 && raw.videoUrl) {
    const idx = queue.indexOf(raw.videoUrl);
    queueIndex = idx >= 0 ? idx : 0;
  }

  const videoUrl =
    queueIndex != null ? (queue[queueIndex] ?? null) : (raw.videoUrl ?? null);

  return {
    version: typeof raw.version === "number" ? raw.version : base.version,
    videoUrl,
    isPlaying: Boolean(raw.isPlaying),
    positionMs:
      typeof raw.positionMs === "number" && raw.positionMs >= 0
        ? raw.positionMs
        : 0,
    serverAnchorMs:
      typeof raw.serverAnchorMs === "number"
        ? raw.serverAnchorMs
        : base.serverAnchorMs,
    hostSessionId:
      typeof raw.hostSessionId === "string" || raw.hostSessionId === null
        ? (raw.hostSessionId ?? null)
        : null,
    updatedAtMs:
      typeof raw.updatedAtMs === "number" ? raw.updatedAtMs : base.updatedAtMs,
    queue,
    queueIndex,
  };
}
