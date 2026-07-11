import { z } from "zod";

export const ROOM_CODE_LENGTH = 8;
export const MAX_MEMBERS = 20;
export const MAX_NICKNAME_LENGTH = 24;
export const MAX_VIDEO_URL_LENGTH = 2048;
export const HOST_HEARTBEAT_MS = 5000;
export const ROOM_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

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

const privateHostPattern =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0|\[::1\]|metadata\.google|169\.254\.)/i;

export function isAllowedVideoUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_VIDEO_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (privateHostPattern.test(url.hostname)) return false;
  return true;
}

export const videoUrlSchema = z
  .string()
  .max(MAX_VIDEO_URL_LENGTH)
  .refine(isAllowedVideoUrl, { message: "URL must be public https" });

export const playbackStateSchema = z.object({
  version: z.number().int().nonnegative(),
  videoUrl: z.string().nullable(),
  isPlaying: z.boolean(),
  positionMs: z.number().nonnegative(),
  serverAnchorMs: z.number().int().nonnegative(),
  hostSessionId: z.string().nullable(),
  updatedAtMs: z.number().int().nonnegative(),
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
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

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
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const createRoomBodySchema = z.object({
  videoUrl: videoUrlSchema.optional(),
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
  };
}
