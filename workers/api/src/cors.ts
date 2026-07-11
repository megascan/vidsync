export function corsHeaders(origin: string | null, allowedOrigin: string): HeadersInit {
  const allow =
    origin === allowedOrigin ||
    (allowedOrigin === "*" && origin != null) ||
    (origin != null && isLocalDevPair(origin, allowedOrigin))
      ? (origin ?? allowedOrigin)
      : allowedOrigin;

  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function isLocalDevPair(origin: string, allowed: string): boolean {
  try {
    const o = new URL(origin);
    const a = new URL(allowed);
    const local = (h: string) => h === "localhost" || h === "127.0.0.1";
    return local(o.hostname) && local(a.hostname);
  } catch {
    return false;
  }
}

export function json(
  data: unknown,
  init: ResponseInit & { origin?: string | null; allowedOrigin: string },
): Response {
  const headers = new Headers(init.headers);
  const cors = corsHeaders(init.origin ?? null, init.allowedOrigin);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}
