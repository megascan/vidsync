import { create } from "zustand";
import type { ChatMessage, Member, PlaybackState } from "@vidsync/shared";
import type { ConnState } from "../sync/client";

const MAX_LOCAL_CHAT = 150;

type RoomStore = {
  code: string | null;
  sessionId: string | null;
  isHost: boolean;
  playback: PlaybackState | null;
  members: Member[];
  chat: ChatMessage[];
  conn: ConnState;
  clockOffsetMs: number;
  lastError: string | null;
  mediaError: string | null;
  nickname: string;
  setCode: (code: string | null) => void;
  setNickname: (nickname: string) => void;
  setConn: (conn: ConnState) => void;
  setWelcome: (p: {
    sessionId: string;
    isHost: boolean;
    state: PlaybackState;
    members: Member[];
  }) => void;
  setPlayback: (state: PlaybackState) => void;
  setMembers: (members: Member[]) => void;
  pushChat: (message: ChatMessage) => void;
  clearChat: () => void;
  setClockOffset: (serverTimeMs: number, localTimeMs: number) => void;
  setLastError: (msg: string | null) => void;
  setMediaError: (msg: string | null) => void;
  setIsHost: (isHost: boolean) => void;
};

export const useRoomStore = create<RoomStore>((set) => ({
  code: null,
  sessionId: null,
  isHost: false,
  playback: null,
  members: [],
  chat: [],
  conn: "idle",
  clockOffsetMs: 0,
  lastError: null,
  mediaError: null,
  nickname: "viewer",
  setCode: (code) => set({ code }),
  setNickname: (nickname) => set({ nickname }),
  setConn: (conn) => set({ conn }),
  setWelcome: (p) =>
    set({
      sessionId: p.sessionId,
      isHost: p.isHost,
      playback: p.state,
      members: p.members,
    }),
  setPlayback: (playback) =>
    set((s) => ({
      playback,
      isHost:
        s.sessionId != null
          ? playback.hostSessionId === s.sessionId
          : s.isHost,
    })),
  setMembers: (members) =>
    set((s) => ({
      members,
      isHost:
        s.sessionId != null
          ? members.some((m) => m.sessionId === s.sessionId && m.isHost)
          : s.isHost,
    })),
  pushChat: (message) =>
    set((s) => ({
      chat: [...s.chat, message].slice(-MAX_LOCAL_CHAT),
    })),
  clearChat: () => set({ chat: [] }),
  setClockOffset: (serverTimeMs, localTimeMs) =>
    set({ clockOffsetMs: serverTimeMs - localTimeMs }),
  setLastError: (lastError) => set({ lastError }),
  setMediaError: (mediaError) => set({ mediaError }),
  setIsHost: (isHost) => set({ isHost }),
}));
