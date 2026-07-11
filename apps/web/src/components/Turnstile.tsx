import { useEffect, useId, useRef } from "react";
import { PUBLIC_TURNSTILE_SITE_KEY } from "astro:env/client";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback?: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      size?: "normal" | "compact" | "flexible";
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onVidSyncTurnstileLoad?: () => void;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onVidSyncTurnstileLoad";

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  const existing = document.getElementById(SCRIPT_ID);
  if (existing) {
    return new Promise((resolve) => {
      const prev = window.onVidSyncTurnstileLoad;
      window.onVidSyncTurnstileLoad = () => {
        prev?.();
        resolve();
      };
      if (window.turnstile) resolve();
    });
  }
  return new Promise((resolve, reject) => {
    window.onVidSyncTurnstileLoad = () => resolve();
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error("Failed to load Turnstile"));
    document.head.appendChild(s);
  });
}

type Props = {
  onToken: (token: string | null) => void;
  resetKey?: number;
};

export default function Turnstile({ onToken, resetKey = 0 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const reactId = useId();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || !hostRef.current || !window.turnstile) return;

        if (widgetIdRef.current) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // ignore
          }
          widgetIdRef.current = null;
        }

        hostRef.current.innerHTML = "";
        const id = window.turnstile.render(hostRef.current, {
          sitekey: PUBLIC_TURNSTILE_SITE_KEY,
          theme: "dark",
          size: "flexible",
          callback: (token) => onToken(token),
          "error-callback": () => onToken(null),
          "expired-callback": () => onToken(null),
        });
        widgetIdRef.current = id;
      } catch {
        onToken(null);
      }
    })();

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
        widgetIdRef.current = null;
      }
    };
    // resetKey forces re-render after failed create (token is single-use)
  }, [onToken, resetKey, reactId]);

  return (
    <div
      ref={hostRef}
      className="mt-3 min-h-[65px]"
      data-turnstile-host
      aria-label="Captcha"
    />
  );
}
