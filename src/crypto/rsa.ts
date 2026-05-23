import { Buffer } from "node:buffer";
import { constants, createPublicKey, publicEncrypt } from "node:crypto";

// Encrypt the password with Steam's RSA public key (hex modulus/exponent → JWK), PKCS#1 v1.5 → base64.
export function encryptPassword(password: string, modHex: string, expHex: string): string {
  const n = Buffer.from(modHex, "hex").toString("base64url");
  const e = Buffer.from(expHex, "hex").toString("base64url");
  const key = createPublicKey({ key: { kty: "RSA", n, e }, format: "jwk" });
  // publicEncrypt defaults to OAEP; Steam needs PKCS#1 v1.5.
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "utf8"),
  ).toString("base64");
}
