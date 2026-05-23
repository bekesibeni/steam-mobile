import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";

// Ported from DoctorMcKay's steam-totp (the few functions we use), so it isn't a runtime dependency.
// The QueryTime server-time call lives in ConfirmationManager so it rides HttpClient (proxy).
const CODE_CHARS = "23456789BCDFGHJKMNPQRTVWXY";

export function time(timeOffset = 0): number {
  return Math.floor(Date.now() / 1000) + timeOffset;
}

// Steam-style TOTP code from a base64/hex/Buffer shared_secret.
export function getAuthCode(secret: Buffer | string, timeOffset = 0): string {
  const key = bufferizeSecret(secret);
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeUInt32BE(0, 0);
  buffer.writeUInt32BE(Math.floor(time(timeOffset) / 30), 4);

  const hmac = createHmac("sha1", key).update(buffer).digest();
  const start = (hmac[19] ?? 0) & 0x0f;
  let fullcode = hmac.subarray(start, start + 4).readUInt32BE(0) & 0x7fffffff;

  let code = "";
  for (let i = 0; i < 5; i++) {
    code += CODE_CHARS.charAt(fullcode % CODE_CHARS.length);
    fullcode /= CODE_CHARS.length;
  }
  return code;
}

// Single-use base64 confirmation key for mobileconf (tag: "conf"/"list"/"allow"/"cancel"/…).
export function getConfirmationKey(
  identitySecret: Buffer | string,
  t: number,
  tag: string,
): string {
  const key = bufferizeSecret(identitySecret);
  const dataLen = 8 + (tag ? Math.min(tag.length, 32) : 0);
  const buffer = Buffer.allocUnsafe(dataLen);
  buffer.writeBigUInt64BE(BigInt(t), 0);
  if (tag) buffer.write(tag, 8);
  return createHmac("sha1", key).update(buffer).digest("base64");
}

// Stable mobileconf device id derived from the steamID (android: + UUID-formatted SHA1).
export function getDeviceID(steamID: string): string {
  const salt = process.env.STEAM_TOTP_SALT ?? "";
  const hash = createHash("sha1")
    .update(steamID + salt)
    .digest("hex")
    .replace(
      /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12}).*$/,
      "$1-$2-$3-$4-$5",
    );
  return `android:${hash}`;
}

function bufferizeSecret(secret: Buffer | string): Buffer {
  if (typeof secret !== "string") return secret;
  return /[0-9a-f]{40}/i.test(secret) ? Buffer.from(secret, "hex") : Buffer.from(secret, "base64");
}
