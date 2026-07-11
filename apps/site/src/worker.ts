/**
 * Landing + R2 download proxy with Workers Cache.
 *
 * Enable: wrangler.jsonc → `"cache": { "enabled": true }`
 * Edge consults cache BEFORE this code runs. HIT = zero R2, zero CPU.
 * Cacheability comes only from response Cache-Control (zone rules ignored).
 *
 * TTL summary:
 *   /latest.json, /updater.json  → 60s public
 *   /downloads/*                 → 1y immutable (versioned filenames)
 *   static ASSETS (html/css/js)  → short (no content-hash in names)
 *   404 on R2 keys               → 30s negative
 */

export interface Env {
  ASSETS: Fetcher;
  DOWNLOADS: R2Bucket;
}

/** Release manifests — short so CI publish is visible quickly. */
const CACHE_JSON = "public, max-age=60";

/**
 * Installers — CI overwrites the same key (not content-addressed).
 * 1 day edge/browser; switch to `immutable` + long max-age once URLs are versioned.
 */
const CACHE_BINARY = "public, max-age=86400";

/** Negative cache for missing R2 objects. */
const CACHE_NOT_FOUND = "public, max-age=30";

/** Landing HTML (names not fingerprinted). */
const CACHE_HTML = "public, max-age=60";

/** CSS/JS without content hashes. */
const CACHE_ASSET = "public, max-age=300";

const CORS_GET = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
} as const;

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    // --- Release manifests (R2) ---
    if (path === "/latest.json" || path === "/updater.json") {
      return serveManifest(request, env, path.slice(1));
    }

    // --- Installers (R2) ---
    if (path.startsWith("/downloads/")) {
      return serveDownload(request, env, path.slice(1));
    }

    // --- Static landing (Worker Assets) ---
    return serveAssets(request, env);
  },
} satisfies ExportedHandler<Env>;

// ── Manifests ───────────────────────────────────────────────────────────────

async function serveManifest(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { ...CORS_GET } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  const obj = await env.DOWNLOADS.get(key);
  if (!obj) {
    // Fall through to ASSETS placeholder if present (public/latest.json)
    if (request.method === "HEAD") {
      return notFound(CACHE_NOT_FOUND, ["vidsync-json", `r2:${key}`]);
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200) {
      return withCacheHeaders(asset, CACHE_JSON, [
        "vidsync-json",
        `r2:${key}`,
        "vidsync-asset",
      ]);
    }
    return notFound(CACHE_NOT_FOUND, ["vidsync-json", `r2:${key}`]);
  }

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": CACHE_JSON,
    "Cache-Tag": cacheTags(["vidsync-json", `r2:${key}`]),
    "Access-Control-Allow-Origin": "*",
    Vary: "Accept-Encoding",
  });
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
  if (obj.uploaded) {
    headers.set("Last-Modified", obj.uploaded.toUTCString());
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(obj.body, { status: 200, headers });
}

// ── Downloads ───────────────────────────────────────────────────────────────

async function serveDownload(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { ...CORS_GET } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  // Range: edge cache still works; R2 get with range for uncached partials
  const range = parseRange(request.headers.get("Range"));

  if (request.method === "HEAD") {
    const head = await env.DOWNLOADS.head(key);
    if (!head) return notFound(CACHE_NOT_FOUND, ["vidsync-download", `r2:${key}`]);
    return new Response(null, {
      status: 200,
      headers: downloadHeaders(key, head.size, head.httpEtag, head.uploaded),
    });
  }

  if (range) {
    // Partial responses (206) are not stored by Workers Cache — serve from R2.
    const obj = await env.DOWNLOADS.get(key, {
      range: { offset: range.offset, length: range.length },
    });
    if (!obj) return notFound(CACHE_NOT_FOUND, ["vidsync-download", `r2:${key}`]);

    const size = obj.size;
    const start = range.offset;
    const end =
      range.length != null
        ? range.offset + range.length - 1
        : Math.max(0, size - 1);
    const headers = downloadHeaders(key, size, obj.httpEtag, obj.uploaded);
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    // Do not mark 206 as immutable long-cache; browsers use full-object cache.
    headers.set("Cache-Control", "public, max-age=3600");
    return new Response(obj.body, { status: 206, headers });
  }

  const obj = await env.DOWNLOADS.get(key);
  if (!obj) return notFound(CACHE_NOT_FOUND, ["vidsync-download", `r2:${key}`]);

  return new Response(obj.body, {
    status: 200,
    headers: downloadHeaders(key, obj.size, obj.httpEtag, obj.uploaded),
  });
}

// ── Static assets ───────────────────────────────────────────────────────────

async function serveAssets(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) {
    return withCacheHeaders(res, CACHE_NOT_FOUND, ["vidsync-asset"]);
  }

  const path = normalizePath(new URL(request.url).pathname);
  const cc =
    path === "/" || path.endsWith(".html")
      ? CACHE_HTML
      : path.endsWith(".css") || path.endsWith(".js")
        ? CACHE_ASSET
        : CACHE_ASSET;

  return withCacheHeaders(res, cc, ["vidsync-asset"]);
}

// ── Headers / helpers ───────────────────────────────────────────────────────

function downloadHeaders(
  key: string,
  size: number,
  etag: string | undefined | null,
  uploaded: Date | undefined,
): Headers {
  const name = key.split("/").pop() ?? "download";
  const headers = new Headers({
    "Content-Type": contentType(name),
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    "Cache-Control": CACHE_BINARY,
    "Cache-Tag": cacheTags(["vidsync-download", `r2:${key}`]),
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
  });
  if (etag) headers.set("ETag", etag);
  if (uploaded) headers.set("Last-Modified", uploaded.toUTCString());
  return headers;
}

function withCacheHeaders(
  res: Response,
  cacheControl: string,
  tags: string[],
): Response {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", cacheControl);
  headers.set("Cache-Tag", cacheTags(tags));
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function notFound(cacheControl: string, tags: string[]): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": cacheControl,
      "Cache-Tag": cacheTags(tags),
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed", {
    status: 405,
    headers: {
      Allow: "GET, HEAD, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}

function cacheTags(tags: string[]): string {
  return tags.join(",");
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function contentType(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".deb")) return "application/vnd.debian.binary-package";
  if (n.endsWith(".json")) return "application/json";
  if (n.endsWith(".exe") || n.endsWith(".msi")) return "application/octet-stream";
  if (n.endsWith(".appimage") || n.endsWith(".sig")) {
    return "application/octet-stream";
  }
  return "application/octet-stream";
}

/**
 * Parse a simple `bytes=start-end` Range header.
 * Multipart ranges not supported → treat as full body.
 */
function parseRange(
  header: string | null,
): { offset: number; length?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d+)?$/i.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (!Number.isFinite(start) || start < 0) return null;
  if (m[2] != null) {
    const end = Number(m[2]);
    if (!Number.isFinite(end) || end < start) return null;
    return { offset: start, length: end - start + 1 };
  }
  return { offset: start };
}
