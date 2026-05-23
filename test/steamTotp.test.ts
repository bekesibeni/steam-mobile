import { describe, expect, it, vi } from "vitest";
import { getAuthCode, getConfirmationKey, getDeviceID, time } from "../src/crypto/steamTotp.js";

// Vectors verified byte-for-byte against steam-totp@2.1.2 before that dependency was dropped.
const SECRET = "sNMbXzfwa1rVPW8ihXJRs4ApINs=";

describe("steamTotp.getAuthCode", () => {
  it("produces the Steam-alphabet TOTP for a fixed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000_000);
    expect(getAuthCode(SECRET)).toBe("37DYD");
    expect(getAuthCode(SECRET, 60)).toBe("332FG"); // next 30s windows
    vi.useRealTimers();
  });
});

describe("steamTotp.getConfirmationKey", () => {
  it("is deterministic per (secret, time, tag)", () => {
    expect(getConfirmationKey(SECRET, 1700000000, "conf")).toBe("2n3GLxEHBh8IRpqdhjeozq1znQc=");
    expect(getConfirmationKey(SECRET, 1700000000, "allow")).toBe("3LKtx+cDAsrZ3hgG61UrSn3O+gQ=");
  });
});

describe("steamTotp.getDeviceID", () => {
  it("derives a stable android: UUID from the steamID", () => {
    expect(getDeviceID("76561198000000000")).toBe("android:5c9df5a2-d7de-1e2c-8fc8-766523ca130f");
    expect(getDeviceID("76561199803868578")).toMatch(
      /^android:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("steamTotp.time", () => {
  it("applies the offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000_000);
    expect(time()).toBe(1700000000);
    expect(time(50)).toBe(1700000050);
    vi.useRealTimers();
  });
});
