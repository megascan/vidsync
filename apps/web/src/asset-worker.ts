/**
 * Serves Astro static assets and rewrites pretty room URLs.
 * /r/XXXXXXXX → room shell (path stays /r/… so client can parse the code).
 * Without this, assets SPA fallback serves home index, or _redirects 307 drops the code.
 */
export interface Env {
  ASSETS: Fetcher;
}

const ROOM_PATH = /^\/r\/([A-Za-z0-9]{6,12})\/?$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (ROOM_PATH.test(url.pathname)) {
      // Internal asset fetch — do not 30x the browser (would lose /r/CODE)
      const roomUrl = new URL("/room/", url.origin);
      return env.ASSETS.fetch(
        new Request(roomUrl, {
          method: request.method,
          headers: request.headers,
          redirect: "manual",
        }),
      );
    }

    return env.ASSETS.fetch(request);
  },
};
