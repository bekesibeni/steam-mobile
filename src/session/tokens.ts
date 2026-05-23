import { Buffer } from "node:buffer";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  CAuthentication_AccessToken_GenerateForApp_RequestSchema as RequestSchema,
  CAuthentication_AccessToken_GenerateForApp_ResponseSchema as ResponseSchema,
} from "../protobufs/steammessages_auth_pb.js";
import type { ProtoPost } from "./protoTransport.js";

export type { ProtoPost } from "./protoTransport.js";

export const GENERATE_TOKEN_URL =
  "https://api.steampowered.com/IAuthenticationService/GenerateAccessTokenForApp/v1";

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

// GenerateAccessTokenForApp_Request: refresh_token=1 string, steamid=2 fixed64, renewal_type=3.
// renewal_type is set explicitly (even to 0) so it's always on the wire, as the iOS app sends it.
export function encodeGenerateForAppRequest(refreshToken: string, renew = false): Buffer {
  const sub = decodeJwt(refreshToken)?.sub;
  if (!sub) throw new AccessTokenError("invalid refresh token: no steamid (sub) in payload");
  let steamId: bigint;
  try {
    steamId = BigInt(sub);
  } catch {
    throw new AccessTokenError(`invalid refresh token: non-numeric steamid '${sub}'`);
  }
  const msg = create(RequestSchema, {
    refreshToken,
    steamid: steamId,
    renewalType: renew ? 1 : 0,
  });
  return Buffer.from(toBinary(RequestSchema, msg));
}

// GenerateAccessTokenForApp_Response: access_token=1 string, refresh_token=2 string.
export function decodeGenerateForAppResponse(input: Buffer | Uint8Array): MintResult {
  let accessToken: string;
  let refreshToken: string;
  try {
    const msg = fromBinary(ResponseSchema, toUint8(input));
    accessToken = msg.accessToken;
    refreshToken = msg.refreshToken;
  } catch {
    throw new AccessTokenError("malformed GenerateAccessTokenForApp response");
  }
  if (!accessToken) throw new AccessTokenError("response had no access_token field");
  return refreshToken ? { accessToken, refreshToken } : { accessToken };
}

function toUint8(input: Buffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array && !Buffer.isBuffer(input) ? input : new Uint8Array(input);
}

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
