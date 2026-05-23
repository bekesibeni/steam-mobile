import { Buffer } from "node:buffer";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPassword } from "../src/crypto/rsa.js";

describe("encryptPassword", () => {
  it("encrypts with hex mod/exp such that the matching private key decrypts it (PKCS#1 v1.5)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    const modHex = Buffer.from(jwk.n, "base64url").toString("hex");
    const expHex = Buffer.from(jwk.e, "base64url").toString("hex");

    const password = "hunter2-pa$$w0rd!";
    const ciphertext = encryptPassword(password, modHex, expHex);

    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(ciphertext, "base64"),
    );
    expect(decrypted.toString("utf8")).toBe(password);
  });

  it("handles Steam's exponent format (010001 = 65537)", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    const expHex = Buffer.from(jwk.e, "base64url").toString("hex");
    expect(Number.parseInt(expHex, 16)).toBe(65537);
  });
});
