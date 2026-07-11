import { useEffect, useState } from "react";
import {
  getUnblockVersion,
  isUnblockInstalled,
  onUnblockReady,
  pingUnblock,
} from "../../lib/unblock/bridge";

export default function UnblockStatus() {
  const [on, setOn] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      const installed = isUnblockInstalled();
      setOn(installed);
      setVersion(getUnblockVersion());
      if (installed) {
        void pingUnblock().then((r) => {
          setOn(r.ok);
          if (r.version) setVersion(r.version);
        });
      }
    };
    sync();
    return onUnblockReady(() => sync());
  }, []);

  if (on) {
    return (
      <span
        className="rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]"
        title="VidSync Unblock is fetching media without page CORS"
      >
        Unblock on{version ? ` v${version}` : ""}
      </span>
    );
  }

  return (
    <a
      href="https://github.com/megascan/vidsync/tree/master/extensions/vidsync-unblock"
      target="_blank"
      rel="noreferrer"
      className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      title="Optional extension: load stubborn streams without CORS"
    >
      Get Unblock
    </a>
  );
}
