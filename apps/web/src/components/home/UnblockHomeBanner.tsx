import { useEffect, useState } from "react";
import { onUnblockReady, pingUnblock } from "../../lib/unblock/bridge";

/** Shown on home when the extension bridge answers. */
export default function UnblockHomeBanner() {
  const [on, setOn] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const apply = (ok: boolean, v: string | null) => {
      setOn(ok);
      if (v) setVersion(v);
    };
    void pingUnblock().then((r) => apply(r.ok, r.version));
    return onUnblockReady((v) => {
      void pingUnblock().then((r) => apply(r.ok, r.version ?? v));
    });
  }, []);

  if (!on) return null;

  return (
    <div className="mb-4 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2 text-xs text-[var(--color-text)]">
      <strong className="text-[var(--color-accent)]">Unblock active</strong>
      {version ? ` v${version}` : ""}. Media can load without page CORS. The
      browser won&apos;t open the extension popup automatically — use the room
      badge / this banner instead.
    </div>
  );
}
