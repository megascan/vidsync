import { useEffect, useState } from "react";
import { onUnblockReady, pingUnblock } from "../../lib/unblock/bridge";

export default function UnblockStatus() {
  const [on, setOn] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    let sawOn = false;
    const sync = (v: string | null, ok: boolean) => {
      setOn(ok);
      if (v) setVersion(v);
      if (ok && !sawOn) {
        sawOn = true;
        setToast(true);
        window.setTimeout(() => setToast(false), 4500);
      }
    };

    void pingUnblock().then((r) => sync(r.version, r.ok));

    return onUnblockReady((v) => {
      void pingUnblock().then((r) => sync(r.version ?? v, r.ok));
    });
  }, []);

  return (
    <>
      {on ? (
        <span
          className="rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]"
          title="VidSync Unblock is active — media can load without page CORS"
        >
          Unblock on{version ? ` v${version}` : ""}
        </span>
      ) : (
        <a
          href="https://github.com/megascan/vidsync/tree/master/extensions/vidsync-unblock"
          target="_blank"
          rel="noreferrer"
          className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          title="Load the unpacked extension, then refresh this tab"
        >
          Get Unblock
        </a>
      )}

      {toast ? (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 max-w-sm -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm shadow-lg"
        >
          <p className="font-medium text-[var(--color-accent)]">
            VidSync Unblock connected
            {version ? ` (v${version})` : ""}
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Stubborn streams can load without CORS. Toolbar popup only opens
            when you click the extension icon (browser rule).
          </p>
        </div>
      ) : null}
    </>
  );
}
