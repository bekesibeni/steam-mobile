import { Buffer } from "node:buffer";
import { ProtoReader, ProtoWriter } from "./proto.js";

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

// GenerateAccessTokenForAppRequest (proto2):
//   refresh_token = 1 (string), steamid = 2 (fixed64), renewal_type = 3 (enum, always emitted)
export function encodeGenerateForAppRequest(refreshToken: string, renew = false): Buffer {
  const sub = decodeJwt(refreshToken)?.sub;
  if (!sub) throw new AccessTokenError("invalid refresh token: no steamid (sub) in payload");
  let steamId: bigint;
  try {
    steamId = BigInt(sub);
  } catch {
    throw new AccessTokenError(`invalid refresh token: non-numeric steamid '${sub}'`);
  }
  return new ProtoWriter()
    .string(1, refreshToken)
    .fixed64(2, steamId)
    .varint(3, renew ? 1 : 0)
    .finish();
}

// GenerateAccessTokenForAppResponse: access_token = 1 (string), refresh_token = 2 (string)
export function decodeGenerateForAppResponse(input: Buffer | Uint8Array): MintResult {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const out: Partial<MintResult> = {};
  try {
    for (const { field, value } of new ProtoReader(buf).fields()) {
      if (value.kind !== "bytes") continue;
      if (field === 1) out.accessToken = value.value.toString("utf8");
      else if (field === 2) out.refreshToken = value.value.toString("utf8");
    }
  } catch {
    throw new AccessTokenError("malformed GenerateAccessTokenForApp response");
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
