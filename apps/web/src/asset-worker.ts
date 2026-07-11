/**
 * Serves Astro static assets and rewrites pretty room URLs.
 * /r/XXXXXXXX → room shell HTML; browser URL stays /r/… so the island can parse the code.
 */
export interface Env {
  ASSETS: {
    fetch: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
  };
}

const ROOM_PATH = /^\/r\/([A-Za-z0-9]{6,12})\/?$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (ROOM_PATH.test(url.pathname)) {
      // Trailing-slash room path is the real asset (index.html 307s under html_handling)
      const assetRes = await env.ASSETS.fetch(
        new Request(new URL("/room/", url.origin), {
          method: "GET",
          headers: request.headers,
          redirect: "follow",
        }),
      );

      // Always return 200 HTML for /r/* — never pass through Location redirects
      // (a browser 3xx to /room/ would drop the room code from the URL bar).
      const headers = new Headers(assetRes.headers);
      headers.delete("Location");
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "text/html; charset=utf-8");
      }

      if (!assetRes.ok) {
        return new Response("Room page unavailable", {
          status: 502,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      return new Response(assetRes.body, {
        status: 200,
        headers,
      });
    }

    return env.ASSETS.fetch(request);
  },
};
