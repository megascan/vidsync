interface Env {
  ROOMS: DurableObjectNamespace;
  WEB_ORIGIN: string;
  ROOM_IDLE_TTL_MS?: string;
  /** Cloudflare Turnstile secret — set via .dev.vars / wrangler secret */
  TURNSTILE_SECRET_KEY: string;
}
