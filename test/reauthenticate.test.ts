import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { HttpClient } from "../src/http/HttpClient.js";
import { SessionManager } from "../src/session/SessionManager.js";

// Minimal refresh-token JWT carrying just a `sub` (steamid) — enough for the steamID-match guard.
function jwt(sub: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

describe("SessionManager.setRefreshToken", () => {
  it("rejects a refresh token for a different account", async () => {
    const sm = new SessionManager({} as unknown as HttpClient, jwt("76561197960287930"));
    await expect(sm.setRefreshToken(jwt("76561197960287931"))).rejects.toThrow(/different account/);
  });

  it("rejects a refresh token with no steamid", async () => {
    const sm = new SessionManager({} as unknown as HttpClient, jwt("76561197960287930"));
    const bad = `header.${Buffer.from(JSON.stringify({ foo: 1 })).toString("base64url")}.sig`;
    await expect(sm.setRefreshToken(bad)).rejects.toThrow(/no steamid/);
  });
});
