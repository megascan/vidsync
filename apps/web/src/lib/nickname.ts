const KEY = "vidsync.nickname";

export function loadNickname(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v && v.trim()) return v.trim().slice(0, 24);
  } catch {
    // ignore
  }
  return defaultNickname();
}

export function saveNickname(name: string): void {
  try {
    localStorage.setItem(KEY, name.trim().slice(0, 24));
  } catch {
    // ignore
  }
}

function defaultNickname(): string {
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `viewer-${n}`;
}
