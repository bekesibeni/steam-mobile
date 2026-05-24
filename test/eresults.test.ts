import { describe, expect, it } from "vitest";
import { EResult } from "../src/core/enums.js";
import { isTerminalAuthEResult, isTransientEResult } from "../src/core/eresults.js";
import { LoginError, ProxyError, SteamError } from "../src/core/errors.js";

describe("eresult classification", () => {
  it("classifies transient eresults", () => {
    expect(isTransientEResult(EResult.ServiceUnavailable)).toBe(true);
    expect(isTransientEResult(EResult.Timeout)).toBe(true);
    expect(isTransientEResult(EResult.InvalidPassword)).toBe(false);
    expect(isTransientEResult(undefined)).toBe(false);
  });

  it("classifies terminal auth eresults (allowlist; unknown → not terminal)", () => {
    expect(isTerminalAuthEResult(EResult.AccessDenied)).toBe(true);
    expect(isTerminalAuthEResult(EResult.Expired)).toBe(true);
    expect(isTerminalAuthEResult(EResult.InvalidPassword)).toBe(true);
    expect(isTerminalAuthEResult(EResult.Timeout)).toBe(false);
    expect(isTerminalAuthEResult(EResult.Fail)).toBe(false);
    expect(isTerminalAuthEResult(undefined)).toBe(false);
  });
});

describe("LoginError.isTransient", () => {
  it("is true for a transient eresult and false for bad credentials", () => {
    expect(new LoginError("blip", { eresult: EResult.ServiceUnavailable }).isTransient).toBe(true);
    expect(new LoginError("bad creds", { eresult: EResult.InvalidPassword }).isTransient).toBe(
      false,
    );
    expect(new LoginError("no eresult").isTransient).toBe(false);
  });
});

describe("ProxyError", () => {
  it("is a SteamError that carries its cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new ProxyError("proxy request failed: ECONNREFUSED", { cause });
    expect(err).toBeInstanceOf(SteamError);
    expect(err.name).toBe("ProxyError");
    expect(err.cause).toBe(cause);
  });
});
