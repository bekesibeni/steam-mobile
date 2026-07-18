import { Buffer } from "node:buffer";
import {
  create,
  fromBinary,
  type MessageInitShape,
  type MessageShape,
  toBinary,
} from "@bufbuild/protobuf";
import { URLS } from "../core/constants.js";
import { EResult } from "../core/enums.js";
import { LoginError, RateLimitError } from "../core/errors.js";
import type { HttpClient } from "../http/HttpClient.js";
import {
  CAuthentication_BeginAuthSessionViaCredentials_RequestSchema as BeginReqSchema,
  CAuthentication_BeginAuthSessionViaCredentials_ResponseSchema as BeginResSchema,
  type CAuthentication_BeginAuthSessionViaCredentials_RequestSchema,
  type EAuthSessionGuardType,
  type EAuthTokenRevokeAction,
  CAuthentication_GetAuthSessionsForAccount_RequestSchema as GetSessReqSchema,
  CAuthentication_GetAuthSessionsForAccount_ResponseSchema as GetSessResSchema,
  CAuthentication_UpdateAuthSessionWithSteamGuardCode_RequestSchema as GuardReqSchema,
  CAuthentication_UpdateAuthSessionWithSteamGuardCode_ResponseSchema as GuardResSchema,
  CAuthentication_PollAuthSessionStatus_RequestSchema as PollReqSchema,
  CAuthentication_PollAuthSessionStatus_ResponseSchema as PollResSchema,
  CAuthentication_RefreshToken_Revoke_RequestSchema as RevokeReqSchema,
  CAuthentication_RefreshToken_Revoke_ResponseSchema as RevokeResSchema,
  CAuthentication_GetPasswordRSAPublicKey_RequestSchema as RsaReqSchema,
  CAuthentication_GetPasswordRSAPublicKey_ResponseSchema as RsaResSchema,
} from "../protobufs/steammessages_auth_pb.js";
import {
  createProtoTransport,
  type ProtoResult,
  type ProtoTransport,
} from "../session/protoTransport.js";

type BeginRequest = MessageInitShape<
  typeof CAuthentication_BeginAuthSessionViaCredentials_RequestSchema
>;

interface SendOptions {
  apiMethod: string;
  method: "GET" | "POST";
  body?: Uint8Array;
  accessToken?: string;
  origin?: boolean;
  multipart?: boolean;
}

// Stateless 1:1 wrappers over the IAuthenticationService protobuf RPCs (the mint lives in tokens.ts).
export class AuthClient {
  private readonly transport: ProtoTransport;

  constructor(http: HttpClient) {
    this.transport = createProtoTransport(http);
  }

  async getPasswordRSAPublicKey(accountName: string): Promise<MessageShape<typeof RsaResSchema>> {
    const body = toBinary(RsaReqSchema, create(RsaReqSchema, { accountName }));
    const out = await this.send({
      apiMethod: "GetPasswordRSAPublicKey",
      method: "GET",
      body,
      origin: true,
    });
    return fromBinary(RsaResSchema, out);
  }

  async beginAuthSessionViaCredentials(
    req: BeginRequest,
  ): Promise<MessageShape<typeof BeginResSchema>> {
    const body = toBinary(BeginReqSchema, create(BeginReqSchema, req));
    const out = await this.send({
      apiMethod: "BeginAuthSessionViaCredentials",
      method: "POST",
      body,
      multipart: true,
    });
    return fromBinary(BeginResSchema, out);
  }

  async pollAuthSessionStatus(
    clientId: bigint,
    requestId: Uint8Array,
  ): Promise<MessageShape<typeof PollResSchema>> {
    const body = toBinary(PollReqSchema, create(PollReqSchema, { clientId, requestId }));
    const out = await this.send({
      apiMethod: "PollAuthSessionStatus",
      method: "POST",
      body,
      multipart: true,
    });
    return fromBinary(PollResSchema, out);
  }

  async updateAuthSessionWithSteamGuardCode(
    clientId: bigint,
    steamid: bigint,
    code: string,
    codeType: number,
  ): Promise<MessageShape<typeof GuardResSchema>> {
    const body = toBinary(
      GuardReqSchema,
      create(GuardReqSchema, {
        clientId,
        steamid,
        code,
        codeType: codeType as EAuthSessionGuardType,
      }),
    );
    const out = await this.send({
      apiMethod: "UpdateAuthSessionWithSteamGuardCode",
      method: "POST",
      body,
      multipart: true,
    });
    return fromBinary(GuardResSchema, out);
  }

  // In-progress auth sessions (login-approval flows), not a device list. GET-only (POST → 405).
  async getAuthSessionsForAccount(
    accessToken: string,
  ): Promise<MessageShape<typeof GetSessResSchema>> {
    const body = toBinary(GetSessReqSchema, create(GetSessReqSchema, {}));
    const out = await this.send({
      apiMethod: "GetAuthSessionsForAccount",
      method: "GET",
      body,
      accessToken,
      origin: true,
    });
    return fromBinary(GetSessResSchema, out);
  }

  // Self-revoke (logout): the query access_token identifies the token; no signature needed.
  async revokeRefreshToken(
    accessToken: string,
    revokeAction: number,
  ): Promise<MessageShape<typeof RevokeResSchema>> {
    const body = toBinary(
      RevokeReqSchema,
      create(RevokeReqSchema, { revokeAction: revokeAction as EAuthTokenRevokeAction }),
    );
    const out = await this.send({
      apiMethod: "RevokeRefreshToken",
      method: "POST",
      body,
      accessToken,
      multipart: true,
    });
    return fromBinary(RevokeResSchema, out);
  }

  private async send(opts: SendOptions): Promise<Uint8Array> {
    const url = `${URLS.api}/IAuthenticationService/${opts.apiMethod}/v1`;
    const res = await this.transport({
      url,
      method: opts.method,
      ...(opts.body ? { body: opts.body } : {}),
      ...(opts.accessToken ? { accessToken: opts.accessToken } : {}),
      ...(opts.origin ? { origin: true } : {}),
      ...(opts.multipart ? { multipart: true } : {}),
    });
    ensureOk(res, opts.apiMethod);
    return toUint8(res.body);
  }
}

function ensureOk(res: ProtoResult, apiMethod: string): void {
  if (res.status === 429) {
    throw new RateLimitError({
      message: `IAuthenticationService/${apiMethod} HTTP 429`,
      ...(res.eresult ? { eresult: Number(res.eresult) } : {}),
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new LoginError(`IAuthenticationService/${apiMethod} HTTP ${res.status}`, {
      ...(res.eresult ? { eresult: Number(res.eresult) } : {}),
      ...(res.errorMessage ? { extendedErrorMessage: res.errorMessage } : {}),
    });
  }
  const er = res.eresult;
  if (er && er !== "1") {
    const code = Number(er);
    // Steam sometimes returns Fail(2) alongside a valid body; treat as success (matches webApi.ts).
    if (code === EResult.Fail && res.body.length > 0) return;
    const name = EResult[code] ?? "EResult";
    const msg = `${apiMethod}: ${name} (${er})${res.errorMessage ? ` ${res.errorMessage}` : ""}`;
    if (code === EResult.RateLimitExceeded)
      throw new RateLimitError({ message: msg, eresult: code });
    throw new LoginError(msg, {
      eresult: code,
      ...(res.errorMessage ? { extendedErrorMessage: res.errorMessage } : {}),
    });
  }
}

function toUint8(input: Buffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array && !Buffer.isBuffer(input) ? input : new Uint8Array(input);
}
