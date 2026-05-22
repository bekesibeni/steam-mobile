import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  AccessTokenError,
  decodeGenerateForAppResponse,
  decodeJwt,
  encodeGenerateForAppRequest,
  secondsUntilExpiry,
} from "../src/session/tokens.js";

const STEAMID = "76561198123456789";

function makeToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJFUzI1NiJ9.${body}.signature`;
}

function lenDelimited(field: number, value: string): number[] {
  const bytes = Buffer.from(value, "utf8");
  const out: number[] = [(field << 3) | 2];
  let n = bytes.length;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return [...out, ...bytes];
}

describe("decodeJwt", () => {
  it("decodes the payload", () => {
    const token = makeToken({ sub: STEAMID, aud: ["web", "mobile"], exp: 123 });
    expect(decodeJwt(token)).toMatchObject({ sub: STEAMID, aud: ["web", "mobile"], exp: 123 });
  });

  it("returns null on garbage", () => {
    expect(decodeJwt("not-a-jwt")).toBeNull();
  });
});

describe("secondsUntilExpiry", () => {
  it("is positive for a future exp", () => {
    const token = makeToken({ sub: STEAMID, exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(secondsUntilExpiry(token)).toBeGreaterThan(3000);
  });

  it("is NaN without exp", () => {
    expect(secondsUntilExpiry(makeToken({ sub: STEAMID }))).toBeNaN();
  });
});

describe("encodeGenerateForAppRequest", () => {
  const token = makeToken({ sub: STEAMID });

  it("emits refresh_token, steamid (fixed64 LE) and renewal_type", () => {
    const buf = encodeGenerateForAppRequest(token, false);
    expect(buf[0]).toBe(0x0a);

    const sidTag = buf.indexOf(0x11);
    expect(sidTag).toBeGreaterThan(0);
    expect(buf.readBigUInt64LE(sidTag + 1)).toBe(BigInt(STEAMID));

    expect(buf[buf.length - 2]).toBe(0x18);
    expect(buf[buf.length - 1]).toBe(0);
  });

  it("sets the renewal_type byte to 1 when renewing", () => {
    const buf = encodeGenerateForAppRequest(token, true);
    expect(buf[buf.length - 1]).toBe(1);
  });

  it("throws when the token has no steamid", () => {
    expect(() => encodeGenerateForAppRequest(makeToken({ aud: ["web"] }))).toThrow(
      AccessTokenError,
    );
  });

  it("throws when the steamid is non-numeric", () => {
    expect(() => encodeGenerateForAppRequest(makeToken({ sub: "abc" }))).toThrow(AccessTokenError);
  });
});

describe("decodeGenerateForAppResponse", () => {
  it("reads access_token and refresh_token", () => {
    const buf = Buffer.from([...lenDelimited(1, "ACCESS"), ...lenDelimited(2, "REFRESH")]);
    expect(decodeGenerateForAppResponse(buf)).toEqual({
      accessToken: "ACCESS",
      refreshToken: "REFRESH",
    });
  });

  it("normalizes a Uint8Array body (got v15 footgun)", () => {
    const buf = Buffer.from(lenDelimited(1, "ACCESS"));
    const u8 = new Uint8Array(buf);
    expect(decodeGenerateForAppResponse(u8)).toEqual({ accessToken: "ACCESS" });
  });

  it("throws on a truncated length-delimited field", () => {
    const buf = Buffer.from([0x0a, 0x05, 0x41]);
    expect(() => decodeGenerateForAppResponse(buf)).toThrow(AccessTokenError);
  });

  it("throws when access_token is absent", () => {
    expect(() => decodeGenerateForAppResponse(Buffer.from(lenDelimited(2, "REFRESH")))).toThrow(
      AccessTokenError,
    );
  });
});
