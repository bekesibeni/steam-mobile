import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMIT_RETRY_MS,
  HttpStatusError,
  RateLimitError,
  SteamSessionExpiredError,
} from "../src/core/errors.js";
import { httpError } from "../src/http/checkers.js";

describe("httpError", () => {
  it("maps 429 to a RateLimitError carrying statusCode (not eresult), with a default unlockAt", () => {
    const err = httpError({ statusCode: 429, headers: {}, body: "x" });
    expect(err).toBeInstanceOf(RateLimitError);
    const rl = err as RateLimitError;
    expect(rl.statusCode).toBe(429);
    expect(rl.eresult).toBeUndefined();
    // No tested window for this endpoint → conservative fallback, never undefined.
    expect(rl.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    expect(rl.unlockAt).toBeGreaterThan(Date.now());
  });

  it("seeds our tested window into retryAfterMs + unlockAt", () => {
    const rl = httpError({ statusCode: 429, headers: {}, body: null }, 120_000) as RateLimitError;
    expect(rl.retryAfterMs).toBe(120_000);
    expect(rl.unlockAt).toBeGreaterThan(Date.now());
  });

  it("keeps the message raw (no synthesized unlock text)", () => {
    const rl = httpError({ statusCode: 429, headers: {}, body: null }, 120_000) as RateLimitError;
    expect(rl.message).toBe("Rate limit exceeded");
  });

  it("maps a login redirect to SteamSessionExpiredError", () => {
    const err = httpError({
      statusCode: 302,
      headers: { location: "https://steamcommunity.com/login" },
      body: "",
    });
    expect(err).toBeInstanceOf(SteamSessionExpiredError);
  });

  it("maps other statuses to HttpStatusError", () => {
    const err = httpError({ statusCode: 500, headers: {}, body: null });
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).statusCode).toBe(500);
  });
});
