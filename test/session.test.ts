import { Buffer } from "node:buffer";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { EResult } from "../src/core/enums.js";
import { SteamSessionExpiredError } from "../src/core/errors.js";
import type { HttpClient } from "../src/http/HttpClient.js";
import {
  CAuthentication_AccessToken_GenerateForApp_RequestSchema as RequestSchema,
  CAuthentication_AccessToken_GenerateForApp_ResponseSchema as ResponseSchema,
} from "../src/protobufs/steammessages_auth_pb.js";
import { SessionManager } from "../src/session/SessionManager.js";

const STEAMID = "76561198123456789";
const nowS = () => Math.floor(Date.now() / 1000);

function makeToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJFUzI1NiJ9.${body}.signature`;
}
const refreshToken = (expDeltaDays: number) =>
  makeToken({ sub: STEAMID, exp: nowS() + expDeltaDays * 86_400 });
const freshAccess = () => makeToken({ sub: STEAMID, aud: ["web", "mobile"], exp: nowS() + 86_400 });

// Pull the renew flag (request field 3) back out of what the session posted.
function renewFlag(base64Body: string): number {
  if (!base64Body) return -1;
  const req = fromBinary(RequestSchema, new Uint8Array(Buffer.from(base64Body, "base64")));
  return req.renewalType;
}

interface PostResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

class FakeHttp {
  lastRenew = -1;
  posted = false;
  constructor(private readonly responder: () => PostResult) {}
  async post(_url: string, opts: { form?: Record<string, unknown> }): Promise<PostResult> {
    this.posted = true;
    this.lastRenew = renewFlag(String(opts.form?.input_protobuf_encoded ?? ""));
    return this.responder();
  }
  async setCookie(): Promise<void> {}
}

function ok(accessToken: string, newRefresh?: string): PostResult {
  const msg = create(ResponseSchema, {
    accessToken,
    ...(newRefresh ? { refreshToken: newRefresh } : {}),
  });
  const body = Buffer.from(toBinary(ResponseSchema, msg));
  return { statusCode: 200, headers: { "x-eresult": "1" }, body };
}
const fail = (eresult: number): PostResult => ({
  statusCode: 200,
  headers: { "x-eresult": String(eresult) },
  body: Buffer.from([]),
});

function makeSession(refresh: string, responder: () => PostResult) {
  const http = new FakeHttp(responder);
  const mgr = new SessionManager(http as unknown as HttpClient, refresh);
  return { mgr, http };
}

describe("SessionManager refresh-token lifecycle", () => {
  it("mints with renew=false when the refresh token is far from expiry", async () => {
    const { mgr, http } = makeSession(refreshToken(200), () => ok(freshAccess()));
    await mgr.getAccessToken();
    expect(http.lastRenew).toBe(0);
  });

  it("mints with renew=true and rotates the refresh token when near expiry", async () => {
    const next = refreshToken(200);
    const { mgr, http } = makeSession(refreshToken(10), () => ok(freshAccess(), next));
    const rotated = vi.fn();
    mgr.on("refreshToken", rotated);

    await mgr.getAccessToken();

    expect(http.lastRenew).toBe(1);
    expect(rotated).toHaveBeenCalledWith(next);
    expect(mgr.refreshToken).toBe(next);
  });

  it("emits sessionExpired and throws WITHOUT hitting the network when already expired", async () => {
    const { mgr, http } = makeSession(refreshToken(-1), () => ok(freshAccess()));
    const expired = vi.fn();
    mgr.on("sessionExpired", expired);

    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(SteamSessionExpiredError);
    expect(expired).toHaveBeenCalledOnce();
    expect(http.posted).toBe(false);
  });

  it("emits sessionExpired on a terminal Steam rejection", async () => {
    const { mgr } = makeSession(refreshToken(200), () => fail(EResult.AccessDenied));
    const expired = vi.fn();
    mgr.on("sessionExpired", expired);

    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(SteamSessionExpiredError);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("does NOT treat a transient Steam error as session-expired", async () => {
    const { mgr } = makeSession(refreshToken(200), () => fail(EResult.ServiceUnavailable));
    const expired = vi.fn();
    mgr.on("sessionExpired", expired);

    await expect(mgr.getAccessToken()).rejects.not.toBeInstanceOf(SteamSessionExpiredError);
    expect(expired).not.toHaveBeenCalled();
  });
});
