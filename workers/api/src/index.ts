import {
  createRoomBodySchema,
  roomCodeSchema,
} from "@vidsync/shared";
import { generateRoomCode } from "./codes";
import { corsHeaders, json } from "./cors";
import { Room } from "./room/Room";
import { verifyTurnstileToken } from "./turnstile";

export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const allowed = env.WEB_ORIGIN || "https://vidsync.ratt.ing";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowed),
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/health") {
        return json(
          { ok: true, service: "vidsync-api" },
          { origin, allowedOrigin: allowed },
        );
      }

      if (request.method === "POST" && path === "/rooms") {
        return await handleCreateRoom(request, env, origin, allowed);
      }

      const roomMatch = path.match(/^\/rooms\/([A-Z0-9]{8})(?:\/(ws|meta))?$/i);
      if (roomMatch) {
        const codeRaw = roomMatch[1] ?? "";
        const code = codeRaw.toUpperCase();
        const parsed = roomCodeSchema.safeParse(code);
        if (!parsed.success) {
          return json(
            { error: "invalid_code" },
            { status: 400, origin, allowedOrigin: allowed },
          );
        }

        const sub = roomMatch[2];
        const stub = env.ROOMS.getByName(code);

        if (sub === "ws" || (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && !sub)) {
          if (request.method !== "GET") {
            return json(
              { error: "method_not_allowed" },
              { status: 405, origin, allowedOrigin: allowed },
            );
          }
          const upgrade = request.headers.get("Upgrade");
          if (!upgrade || upgrade.toLowerCase() !== "websocket") {
            return new Response("Expected WebSocket upgrade", { status: 426 });
          }
          return stub.fetch(
            new Request(`https://room/ws`, {
              method: "GET",
              headers: request.headers,
            }),
          );
        }

        if (request.method === "GET" && (sub === "meta" || !sub)) {
          const res = await stub.fetch(new Request("https://room/meta", { method: "GET" }));
          const body = await res.text();
          const headers = new Headers(corsHeaders(origin, allowed));
          headers.set("Content-Type", "application/json; charset=utf-8");
          return new Response(body, { status: res.status, headers });
        }
      }

      return json(
        { error: "not_found" },
        { status: 404, origin, allowedOrigin: allowed },
      );
    } catch (err) {
      console.error(err);
      return json(
        { error: "internal", message: "Internal error" },
        { status: 500, origin, allowedOrigin: allowed },
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function handleCreateRoom(
  request: Request,
  env: Env,
  origin: string | null,
  allowed: string,
): Promise<Response> {
  let raw: unknown = {};
  const text = await request.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      return json(
        { error: "invalid_json" },
        { status: 400, origin, allowedOrigin: allowed },
      );
    }
  }

  const body = createRoomBodySchema.safeParse(raw);
  if (!body.success) {
    return json(
      {
        error: "invalid_body",
        message: body.error.issues[0]?.message ?? "Invalid body",
      },
      { status: 400, origin, allowedOrigin: allowed },
    );
  }

  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return json(
      {
        error: "misconfigured",
        message: "Turnstile secret not configured",
      },
      { status: 503, origin, allowedOrigin: allowed },
    );
  }

  const remoteIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null;

  const captcha = await verifyTurnstileToken({
    secret,
    token: body.data.turnstileToken,
    remoteIp,
  });
  if (!captcha.ok) {
    return json(
      {
        error: "captcha_failed",
        message: "Captcha verification failed. Refresh and try again.",
        codes: captcha.codes,
      },
      { status: 403, origin, allowedOrigin: allowed },
    );
  }

  // Rare collision: retry a few times
  let code = generateRoomCode();
  for (let i = 0; i < 5; i++) {
    const stub = env.ROOMS.getByName(code);
    const initRes = await stub.fetch(
      new Request("https://room/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          videoUrl: body.data.videoUrl,
        }),
      }),
    );
    if (initRes.ok) {
      const meta = (await initRes.json()) as { code: string };
      const wsUrl = wsUrlFor(request, meta.code);
      return json(
        { code: meta.code, wsUrl },
        { status: 201, origin, allowedOrigin: allowed },
      );
    }
    code = generateRoomCode();
  }

  return json(
    { error: "create_failed" },
    { status: 500, origin, allowedOrigin: allowed },
  );
}

function wsUrlFor(request: Request, code: string): string {
  const url = new URL(request.url);
  const proto = url.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${url.host}/rooms/${code}/ws`;
}
