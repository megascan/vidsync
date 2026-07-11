type SiteverifyResponse = {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
};

export async function verifyTurnstileToken(opts: {
  secret: string;
  token: string;
  remoteIp?: string | null;
}): Promise<{ ok: true } | { ok: false; codes: string[] }> {
  const body = new URLSearchParams();
  body.set("secret", opts.secret);
  body.set("response", opts.token);
  if (opts.remoteIp) {
    body.set("remoteip", opts.remoteIp);
  }

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  if (!res.ok) {
    return { ok: false, codes: ["siteverify_http_error"] };
  }

  const data = (await res.json()) as SiteverifyResponse;
  if (data.success) {
    return { ok: true };
  }
  return { ok: false, codes: data["error-codes"] ?? ["unknown"] };
}
