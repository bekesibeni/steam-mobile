import { describe, expect, it } from "vitest";
import { decodePreviewToken, encodePreviewToken } from "../src/models/inspect.js";

// Real propertyid-6 certificate; its paintseed/paintwear match the sibling
// propertyid 1 (int_value "383") and propertyid 2 (float 0.4817778766155243).
const CERT = "2E3ECAD485F3EE2F36290ED926062B1E2A16B9F9F4D92D6ED12C46285E26225895C6";

describe("decodePreviewToken", () => {
  it("decodes a masked certificate token to JSON", () => {
    const data = decodePreviewToken(CERT);
    expect(data).not.toBeNull();
    expect(typeof data?.itemid).toBe("string"); // uint64 → string
    expect(data?.defindex).toBe(7);
    expect(data?.paintindex).toBe(1143);
    expect(data?.rarity).toBe(5);
    expect(data?.quality).toBe(4);
    expect(data?.paintseed).toBe(383);
    expect(data?.paintwear).toBeCloseTo(0.4817778766155243, 12);
  });

  it("returns null for non-hex input", () => {
    expect(decodePreviewToken(null)).toBeNull();
    expect(decodePreviewToken("")).toBeNull();
    expect(decodePreviewToken("not-hex!!")).toBeNull();
  });
});

describe("encodePreviewToken", () => {
  it("round-trips a real certificate byte for byte, key included", () => {
    const data = decodePreviewToken(CERT);
    expect(data).not.toBeNull();
    expect(encodePreviewToken(data as Record<string, unknown>, 0x2e)).toBe(CERT);
  });

  it("emits an unmasked payload for key 0 that decodes to the same item", () => {
    const data = decodePreviewToken(CERT) as Record<string, unknown>;
    const plain = encodePreviewToken(data);
    expect(plain).not.toBeNull();
    expect(plain?.startsWith("00")).toBe(true);
    expect(decodePreviewToken(plain)).toEqual(data);
  });

  it("survives every key byte", () => {
    const data = decodePreviewToken(CERT) as Record<string, unknown>;
    for (let key = 0; key <= 0xff; key++) {
      expect(decodePreviewToken(encodePreviewToken(data, key))).toEqual(data);
    }
  });

  it("returns null for an invalid item or key", () => {
    expect(encodePreviewToken({ notAField: 1 })).toBeNull();
    expect(encodePreviewToken({ defindex: 7 }, 256)).toBeNull();
    expect(encodePreviewToken({ defindex: 7 }, -1)).toBeNull();
  });
});
