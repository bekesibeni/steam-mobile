import { Buffer } from "node:buffer";

export const GENERATE_TOKEN_URL =
  "https://api.steampowered.com/IAuthenticationService/GenerateAccessTokenForApp/v1/";

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string[];
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

export interface MintResult {
  accessToken: string;
  refreshToken?: string;
}

export class AccessTokenError extends Error {
  constructor(
    message: string,
    readonly eresult?: number,
  ) {
    super(message);
    this.name = "AccessTokenError";
  }
}

export function decodeJwt(token: string): JwtPayload | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

export function secondsUntilExpiry(token: string): number {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === "number" ? exp - Math.floor(Date.now() / 1000) : Number.NaN;
}

function writeVarint(value: number): number[] {
  const out: number[] = [];
  let n = value;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export function encodeGenerateForAppRequest(refreshToken: string, renew = false): Buffer {
  const bytes: number[] = [];
  const rt = Buffer.from(refreshToken, "utf8");
  bytes.push(0x0a, ...writeVarint(rt.length), ...rt);

  const sub = decodeJwt(refreshToken)?.sub;
  if (!sub) throw new AccessTokenError("invalid refresh token: no steamid (sub) in payload");
  const sid = Buffer.alloc(8);
  try {
    sid.writeBigUInt64LE(BigInt(sub));
  } catch {
    throw new AccessTokenError(`invalid refresh token: non-numeric steamid '${sub}'`);
  }
  bytes.push(0x11, ...sid);

  bytes.push(0x18, renew ? 1 : 0);
  return Buffer.from(bytes);
}

export function decodeGenerateForAppResponse(input: Buffer | Uint8Array): MintResult {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const malformed = () => new AccessTokenError("malformed GenerateAccessTokenForApp response");

  const out: Partial<MintResult> = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++] as number;
    const field = tag >> 3;
    const wire = tag & 0x07;
    if (wire === 2) {
      let len = 0;
      let shift = 0;
      let b: number;
      do {
        if (i >= buf.length) throw malformed();
        b = buf[i++] as number;
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      if (i + len > buf.length) throw malformed();
      const val = buf.subarray(i, i + len).toString("utf8");
      i += len;
      if (field === 1) out.accessToken = val;
      else if (field === 2) out.refreshToken = val;
    } else if (wire === 0) {
      while (i < buf.length && ((buf[i++] as number) & 0x80) !== 0) {}
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw malformed();
    }
  }
  if (!out.accessToken) throw new AccessTokenError("response had no access_token field");
  return out as MintResult;
}

export type ProtoPost = (
  url: string,
  base64Body: string,
) => Promise<{
  status: number;
  eresult: string | null;
  errorMessage?: string | null;
  body: Buffer | Uint8Array;
}>;

const ERESULT_OK = "1";

export async function mintAccessToken(
  refreshToken: string,
  renew: boolean,
  post: ProtoPost,
): Promise<MintResult> {
  const req = encodeGenerateForAppRequest(refreshToken, renew);
  const { status, eresult, errorMessage, body } = await post(
    GENERATE_TOKEN_URL,
    req.toString("base64"),
  );

  if (status < 200 || status >= 300) {
    throw new AccessTokenError(
      `GenerateAccessTokenForApp HTTP ${status} (eresult=${eresult ?? "?"}${errorMessage ? `, ${errorMessage}` : ""})`,
      eresult ? Number(eresult) : undefined,
    );
  }
  if (eresult && eresult !== ERESULT_OK) {
    throw new AccessTokenError(
      `GenerateAccessTokenForApp failed: eresult=${eresult}${errorMessage ? ` (${errorMessage})` : ""}`,
      Number(eresult),
    );
  }
  if (!body.length) {
    throw new AccessTokenError(
      `GenerateAccessTokenForApp empty response (eresult=${eresult ?? "?"})`,
    );
  }
  return decodeGenerateForAppResponse(body);
}
