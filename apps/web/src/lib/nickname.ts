import { MAX_NICKNAME_LENGTH } from "@vidsync/shared";

const KEY = "vidsync.nickname";

/** Returns saved nick or null if user never set one. */
export function loadStoredNickname(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v && v.trim()) return normalizeNickname(v);
  } catch {
    // ignore
  }
  return null;
}

/** Saved nick, or a random default (does not persist the default). */
export function loadNickname(): string {
  return loadStoredNickname() ?? defaultNickname();
}

export function hasStoredNickname(): boolean {
  return loadStoredNickname() != null;
}

export function normalizeNickname(raw: string): string {
  return raw
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_NICKNAME_LENGTH);
}

export function saveNickname(name: string): string {
  const n = normalizeNickname(name);
  if (!n) return n;
  try {
    localStorage.setItem(KEY, n);
  } catch {
    // ignore
  }
  return n;
}

function defaultNickname(): string {
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `viewer-${n}`;
}
