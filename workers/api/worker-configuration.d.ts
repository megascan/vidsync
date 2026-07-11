interface Env {
  ROOMS: DurableObjectNamespace;
  /**
   * Comma-separated browser origins allowed for CORS + WS Origin check.
   * Example: `https://vidsync.ratt.ing` or `http://localhost:4321`
   * localhost ↔ 127.0.0.1 twins are expanded automatically.
   */
  WEB_ORIGIN: string;
  ROOM_IDLE_TTL_MS?: string;
  /** Cloudflare Turnstile secret — set via .dev.vars / wrangler secret */
  TURNSTILE_SECRET_KEY: string;
}
