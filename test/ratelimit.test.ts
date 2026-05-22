import { describe, expect, it } from "vitest";
import { HttpStatusError, RateLimitError, SteamSessionExpiredError } from "../src/core/errors.js";
import { httpError } from "../src/http/checkers.js";

describe("httpError", () => {
  it("maps 429 to a RateLimitError carrying statusCode (not eresult)", () => {
    const err = httpError({ statusCode: 429, headers: {}, body: "x" });
    expect(err).toBeInstanceOf(RateLimitError);
    const rl = err as RateLimitError;
    expect(rl.statusCode).toBe(429);
    expect(rl.eresult).toBeUndefined();
    expect(rl.retryAfterMs).toBeUndefined();
    expect(rl.unlockAt).toBeUndefined();
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
