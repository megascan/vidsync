/**
 * Landing site + download proxy from R2.
 * Static files via ASSETS; binaries + latest.json from DOWNLOADS bucket.
 */

export interface Env {
  ASSETS: Fetcher;
  DOWNLOADS: R2Bucket;
}

const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_JSON = "public, max-age=60";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (
      path === "/latest.json" ||
      path === "/latest.json/" ||
      path === "/updater.json" ||
      path === "/updater.json/"
    ) {
      const key = path.replace(/\/$/, "").replace(/^\//, "");
      const obj = await env.DOWNLOADS.get(key);
      if (obj) {
        return new Response(obj.body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": CACHE_JSON,
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      // fall through to static placeholder
    }

    if (path.startsWith("/downloads/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      const key = path.replace(/^\//, "");
      if (request.method === "HEAD") {
        const head = await env.DOWNLOADS.head(key);
        if (!head) return new Response("Not found", { status: 404 });
        return new Response(null, {
          status: 200,
          headers: downloadHeaders(key, head.size, head.httpEtag),
        });
      }

      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      const obj = await env.DOWNLOADS.get(key);
      if (!obj) return new Response("Not found", { status: 404 });

      return new Response(obj.body, {
        headers: downloadHeaders(key, obj.size, obj.httpEtag),
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function downloadHeaders(
  key: string,
  size: number,
  etag: string,
): HeadersInit {
  const name = key.split("/").pop() ?? "download";
  return {
    "Content-Type": contentType(name),
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    "Cache-Control": CACHE_IMMUTABLE,
    ETag: etag,
    "Access-Control-Allow-Origin": "*",
  };
}

function contentType(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".deb")) return "application/vnd.debian.binary-package";
  if (n.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
