import { useCallback, useEffect, useState } from "react";
import { createRoom } from "../../lib/api";
import {
  loadStoredNickname,
  normalizeNickname,
  saveNickname,
} from "../../lib/nickname";
import { isValidRoomCode, normalizeRoomCode } from "../../lib/roomCode";
import Turnstile from "../Turnstile";
import UnblockHomeBanner from "./UnblockHomeBanner";

export default function HomeApp() {
  const [nickname, setNickname] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  useEffect(() => {
    const stored = loadStoredNickname();
    if (stored) setNickname(stored);
  }, []);

  const onToken = useCallback((token: string | null) => {
    setTurnstileToken(token);
  }, []);

  function commitNick(): string | null {
    const n = normalizeNickname(nickname);
    if (!n) {
      setError("Pick a nickname first.");
      return null;
    }
    saveNickname(n);
    setNickname(n);
    return n;
  }

  async function onCreate() {
    setError(null);
    if (!commitNick()) return;
    if (!turnstileToken) {
      setError("Complete the captcha first.");
      return;
    }
    setBusy(true);
    try {
      const { code } = await createRoom({ turnstileToken });
      if (!code || !isValidRoomCode(code)) {
        throw new Error("Server returned an invalid room code");
      }
      goToRoom(normalizeRoomCode(code));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create room");
      setTurnstileToken(null);
      setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  function onJoin() {
    setError(null);
    if (!commitNick()) return;
    const code = normalizeRoomCode(joinCode);
    if (!isValidRoomCode(code)) {
      setError("Enter a valid 8-character room code.");
      return;
    }
    goToRoom(code);
  }

  function goToRoom(code: string) {
    window.location.assign(`/r/${code}`);
  }

  const nickOk = normalizeNickname(nickname).length > 0;

  return (
    <div className="flex flex-col gap-6">
      <UnblockHomeBanner />
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-medium">Your nickname</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Shown in the room and chat. Saved in this browser.
        </p>
        <label className="mt-3 block text-xs text-[var(--color-muted)]">
          Nickname
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onBlur={() => {
              const n = normalizeNickname(nickname);
              if (n) {
                saveNickname(n);
                setNickname(n);
              }
            }}
            placeholder="e.g. strange"
            maxLength={24}
            autoComplete="nickname"
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-medium">Create room</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
          Opens an empty sync group. Host queues http(s) streams after join
          (public CDN or LAN).
        </p>

        <Turnstile onToken={onToken} resetKey={captchaReset} />

        <button
          type="button"
          disabled={busy || !turnstileToken || !nickOk}
          onClick={() => void onCreate()}
          className="mt-3 w-full rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create room"}
        </button>
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-medium">Join room</h2>
        <label className="mt-3 block text-xs text-[var(--color-muted)]">
          Room code
          <input
            type="text"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="A1B2C3D4"
            maxLength={8}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm tracking-widest text-[var(--color-text)] uppercase outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <button
          type="button"
          disabled={!nickOk}
          onClick={onJoin}
          className="mt-3 w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:border-[var(--color-muted)] disabled:opacity-50"
        >
          Join
        </button>
      </section>

      {error ? (
        <p className="text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
