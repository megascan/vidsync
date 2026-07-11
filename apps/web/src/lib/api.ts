import { PUBLIC_API_URL } from "astro:env/client";

export function apiBase(): string {
  return PUBLIC_API_URL.replace(/\/+$/, "");
}

export function wsUrlForRoom(code: string): string {
  const base = apiBase();
  const u = new URL(base);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/rooms/${code.toUpperCase()}/ws`;
}

export async function createRoom(opts: {
  videoUrl?: string;
  turnstileToken: string;
}): Promise<{
  code: string;
  wsUrl: string;
}> {
  const res = await fetch(`${apiBase()}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      turnstileToken: opts.turnstileToken,
      ...(opts.videoUrl ? { videoUrl: opts.videoUrl } : {}),
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(err?.message ?? err?.error ?? `Create failed (${res.status})`);
  }
  return (await res.json()) as { code: string; wsUrl: string };
}
