import { ROOM_CODE_LENGTH, roomCodeSchema } from "@vidsync/shared";

/** Parse room code from /r/CODE or ?code= or /room path leftovers. */
export function parseRoomCodeFromLocation(
  pathname: string,
  search: string,
): string | null {
  const params = new URLSearchParams(search);
  const q = params.get("code");
  if (q) {
    const up = q.trim().toUpperCase();
    if (roomCodeSchema.safeParse(up).success) return up;
  }

  const m = pathname.match(/\/r\/([A-Za-z0-9]{6,12})\/?$/);
  if (m?.[1]) {
    const up = m[1].toUpperCase();
    if (roomCodeSchema.safeParse(up).success) return up;
  }

  return null;
}

export function isValidRoomCode(code: string): boolean {
  return roomCodeSchema.safeParse(code.trim().toUpperCase()).success;
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase().slice(0, ROOM_CODE_LENGTH);
}
