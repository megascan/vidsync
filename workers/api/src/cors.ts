const DEFAULT_ORIGINS = ["https://vidsync.ratt.ing"];

/** Parse comma-separated WEB_ORIGIN list; normalize; expand localhost ↔ 127.0.0.1. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const parts = (raw?.trim() ? raw.split(",") : DEFAULT_ORIGINS)
    .map((s) => normalizeOrigin(s.trim()))
    .filter((s): s is string => s != null);

  const set = new Set<string>(parts.length > 0 ? parts : DEFAULT_ORIGINS);
  for (const origin of [...set]) {
    for (const twin of localOriginTwins(origin)) {
      set.add(twin);
    }
  }
  return [...set];
}

export function normalizeOrigin(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** localhost:port ↔ 127.0.0.1:port so either host works in dev. */
function localOriginTwins(origin: string): string[] {
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost") {
      return [`${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ""}`];
    }
    if (u.hostname === "127.0.0.1") {
      return [`${u.protocol}//localhost${u.port ? `:${u.port}` : ""}`];
    }
  } catch {
    // ignore
  }
  return [];
}

export function isOriginAllowed(
  origin: string | null,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return allowedOrigins.includes(normalized);
}

/**
 * Build CORS headers only when Origin is on the allowlist.
 * Disallowed / missing Origin → no Access-Control-Allow-Origin (browser blocks).
 */
export function corsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
): Headers {
  const headers = new Headers();
  headers.set("Vary", "Origin");

  if (!isOriginAllowed(origin, allowedOrigins) || !origin) {
    return headers;
  }

  const allowed = normalizeOrigin(origin) ?? origin;
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  // No credentials — we don't use cookies; omit Allow-Credentials.

  return headers;
}

/** OPTIONS preflight: 204 + CORS if allowed, else 403. */
export function handlePreflight(
  request: Request,
  allowedOrigins: readonly string[],
): Response {
  const origin = request.headers.get("Origin");
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return new Response(null, {
      status: 403,
      headers: { Vary: "Origin" },
    });
  }

  const headers = corsHeaders(origin, allowedOrigins);

  // Only permit Content-Type (what our API uses). Ignore arbitrary request headers.
  const requested = request.headers.get("Access-Control-Request-Headers");
  if (requested) {
    const ok = requested
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .every((h) => h === "content-type" || h === "");
    if (!ok) {
      return new Response(null, {
        status: 403,
        headers: { Vary: "Origin" },
      });
    }
  }

  return new Response(null, { status: 204, headers });
}

/**
 * WebSocket: browsers send Origin — require allowlist.
 * Missing Origin (CLI/tools) allowed for local debugging.
 */
export function isWebSocketOriginOk(
  origin: string | null,
  allowedOrigins: readonly string[],
): boolean {
  if (origin == null || origin === "") return true;
  return isOriginAllowed(origin, allowedOrigins);
}

export function json(
  data: unknown,
  init: ResponseInit & {
    origin?: string | null;
    allowedOrigins: readonly string[];
  },
): Response {
  const headers = new Headers(init.headers);
  const cors = corsHeaders(init.origin ?? null, init.allowedOrigins);
  cors.forEach((value, key) => {
    headers.set(key, value);
  });
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), {
    status: init.status,
    statusText: init.statusText,
    headers,
  });
}

/** Attach CORS to an existing Response (e.g. proxied DO meta). */
export function withCors(
  response: Response,
  origin: string | null,
  allowedOrigins: readonly string[],
): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin, allowedOrigins);
  cors.forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
