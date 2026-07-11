import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@vidsync/shared";

export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const b = bytes[i] ?? 0;
    out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  }
  return out;
}
