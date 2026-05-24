import { EventEmitter } from "node:events";
import SteamID from "steamid";
import { AuthClient } from "../auth/AuthClient.js";
import {
  ACCESS_TOKEN_RENEW_THRESHOLD_SECONDS,
  REFRESH_TOKEN_RENEW_THRESHOLD_SECONDS,
} from "../core/constants.js";
import { EAuthTokenRevokeAction } from "../core/enums.js";
import { isTerminalAuthEResult } from "../core/eresults.js";
import { SteamError, SteamSessionExpiredError } from "../core/errors.js";
import type { HttpClient } from "../http/HttpClient.js";
import { createProtoPost, type ProtoPost } from "./protoTransport.js";
import {
  AccessTokenError,
  decodeJwt,
  type MintResult,
  mintAccessToken,
  secondsUntilExpiry,
} from "./tokens.js";

export interface SessionManagerEvents {
  refreshToken: [token: string];
  sessionExpired: [error: Error];
  debug: [message: string];
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  refreshToken: string;
  accessToken: string | undefined;
  readonly steamID: SteamID;
  private readonly http: HttpClient;
  private readonly protoPost: ProtoPost;
  private minting: Promise<string> | undefined;
  private revoked = false;

  constructor(http: HttpClient, refreshToken: string) {
    super();
    const sub = decodeJwt(refreshToken)?.sub;
    if (!sub)
      throw new SteamSessionExpiredError("invalid refresh token: no steamid (sub) in payload");
    this.http = http;
    this.protoPost = createProtoPost(http);
    this.refreshToken = refreshToken;
    this.steamID = new SteamID(sub);
  }

  async getAccessToken(): Promise<string> {
    if (this.revoked) throw new SteamSessionExpiredError("session has been revoked (logged out)");
    if (
      this.accessToken &&
      secondsUntilExpiry(this.accessToken) > ACCESS_TOKEN_RENEW_THRESHOLD_SECONDS
    ) {
      return this.accessToken;
    }
    if (!this.minting) {
      this.minting = this.mint().finally(() => {
        this.minting = undefined;
      });
    }
    return this.minting;
  }

  // Client ids of in-progress auth sessions (login-approval flows), not a device list.
  async listSessions(): Promise<bigint[]> {
    const accessToken = await this.getAccessToken();
    const res = await new AuthClient(this.http).getAuthSessionsForAccount(accessToken);
    return res.clientIds;
  }

  // Revoke this refresh token; the session is dead afterward and further calls throw.
  async logout(action: EAuthTokenRevokeAction = EAuthTokenRevokeAction.Logout): Promise<void> {
    const accessToken = await this.getAccessToken();
    await new AuthClient(this.http).revokeRefreshToken(accessToken, action);
    this.revoked = true;
    this.accessToken = undefined;
    this.emit("debug", "refresh token revoked (logout)");
  }

  async setRefreshToken(refreshToken: string): Promise<void> {
    const sub = decodeJwt(refreshToken)?.sub;
    if (!sub) {
      throw new SteamSessionExpiredError("invalid refresh token: no steamid (sub) in payload");
    }
    if (sub !== this.steamID.getSteamID64()) {
      throw new SteamError(
        `refresh token is for a different account (${sub} != ${this.steamID.getSteamID64()})`,
      );
    }
    this.refreshToken = refreshToken;
    this.revoked = false;
    this.accessToken = undefined;
    this.emit("refreshToken", refreshToken);
    await this.getAccessToken();
  }

  private async mint(): Promise<string> {
    const refreshExpiresIn = secondsUntilExpiry(this.refreshToken);
    if (refreshExpiresIn <= 0) {
      throw this.expire("refresh token has expired — re-authentication required");
    }

    const renew = refreshExpiresIn < REFRESH_TOKEN_RENEW_THRESHOLD_SECONDS;
    let result: MintResult;
    try {
      result = await mintAccessToken(this.refreshToken, renew, this.protoPost);
    } catch (err) {
      if (err instanceof AccessTokenError && isTerminalAuthFailure(err)) {
        throw this.expire(`refresh token rejected by Steam: ${err.message}`);
      }
      throw err;
    }

    this.accessToken = result.accessToken;
    if (result.refreshToken && result.refreshToken !== this.refreshToken) {
      this.refreshToken = result.refreshToken;
      this.emit("refreshToken", result.refreshToken);
    }
    await this.applyLoginCookie();
    this.emit(
      "debug",
      `minted access token${renew ? " + renewed refresh token" : ""}, expires in ` +
        `${Math.round(secondsUntilExpiry(result.accessToken))}s`,
    );
    return result.accessToken;
  }

  // Emit sessionExpired so a global handler can trigger re-auth.
  private expire(message: string): SteamSessionExpiredError {
    const err = new SteamSessionExpiredError(message);
    this.emit("sessionExpired", err);
    return err;
  }

  private async applyLoginCookie(): Promise<void> {
    const value = encodeURIComponent(`${this.steamID.getSteamID64()}||${this.accessToken}`);
    await this.http.setCookie(`steamLoginSecure=${value}`);
  }
}

function isTerminalAuthFailure(err: AccessTokenError): boolean {
  return isTerminalAuthEResult(err.eresult);
}
