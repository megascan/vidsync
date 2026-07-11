import { describe, expect, test } from "bun:test";
import {
  corsHeaders,
  handlePreflight,
  isOriginAllowed,
  isWebSocketOriginOk,
  parseAllowedOrigins,
} from "./cors";

describe("parseAllowedOrigins", () => {
  test("defaults to prod", () => {
    expect(parseAllowedOrigins(undefined)).toContain("https://vidsync.ratt.ing");
  });

  test("expands localhost twins", () => {
    const list = parseAllowedOrigins("http://localhost:4321");
    expect(list).toContain("http://localhost:4321");
    expect(list).toContain("http://127.0.0.1:4321");
  });

  test("comma-separated", () => {
    const list = parseAllowedOrigins(
      "https://vidsync.ratt.ing, https://www.vidsync.ratt.ing",
    );
    expect(list).toContain("https://vidsync.ratt.ing");
    expect(list).toContain("https://www.vidsync.ratt.ing");
  });
});

describe("corsHeaders", () => {
  const allowed = parseAllowedOrigins("https://vidsync.ratt.ing");

  test("echoes allowlisted origin only", () => {
    const h = corsHeaders("https://vidsync.ratt.ing", allowed);
    expect(h.get("Access-Control-Allow-Origin")).toBe("https://vidsync.ratt.ing");
    expect(h.get("Vary")).toBe("Origin");
  });

  test("does not set ACAO for evil origin", () => {
    const h = corsHeaders("https://evil.example", allowed);
    expect(h.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("does not set ACAO when origin missing", () => {
    const h = corsHeaders(null, allowed);
    expect(h.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("handlePreflight", () => {
  const allowed = parseAllowedOrigins("http://localhost:4321");

  test("204 for allowed origin", () => {
    const req = new Request("http://api.test/rooms", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4321",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const res = handlePreflight(req, allowed);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:4321",
    );
  });

  test("403 for disallowed origin", () => {
    const req = new Request("http://api.test/rooms", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    const res = handlePreflight(req, allowed);
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("isWebSocketOriginOk", () => {
  const allowed = parseAllowedOrigins("https://vidsync.ratt.ing");

  test("allows missing origin", () => {
    expect(isWebSocketOriginOk(null, allowed)).toBe(true);
  });

  test("allows allowlisted", () => {
    expect(isWebSocketOriginOk("https://vidsync.ratt.ing", allowed)).toBe(true);
  });

  test("blocks evil", () => {
    expect(isWebSocketOriginOk("https://evil.example", allowed)).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  const allowed = parseAllowedOrigins("http://localhost:4321");

  test("127 twin allowed", () => {
    expect(isOriginAllowed("http://127.0.0.1:4321", allowed)).toBe(true);
  });
});
