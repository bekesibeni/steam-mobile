import { EventEmitter } from "node:events";
import SteamID from "steamid";
import { ACCESS_TOKEN_RENEW_THRESHOLD_SECONDS } from "../constants.js";
import { SteamSessionExpiredError } from "../errors.js";
import type { HttpClient } from "../http/HttpClient.js";
import { decodeJwt, mintAccessToken, type ProtoPost, secondsUntilExpiry } from "./tokens.js";

export interface SessionManagerEvents {
  refreshToken: [token: string];
  sessionExpired: [error: Error];
  debug: [message: string];
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  refreshToken: string;
  accessToken?: string;
  readonly steamID: SteamID;
  private readonly http: HttpClient;
  private minting: Promise<string> | undefined;

  private constructor(http: HttpClient, refreshToken: string, steamID: SteamID) {
    super();
    this.http = http;
    this.refreshToken = refreshToken;
    this.steamID = steamID;
  }

  static async fromRefreshToken(http: HttpClient, refreshToken: string): Promise<SessionManager> {
    const sub = decodeJwt(refreshToken)?.sub;
    if (!sub)
      throw new SteamSessionExpiredError("invalid refresh token: no steamid (sub) in payload");
    const mgr = new SessionManager(http, refreshToken, new SteamID(sub));
    await mgr.getAccessToken();
    return mgr;
  }

  async getAccessToken(): Promise<string> {
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

  private async mint(): Promise<string> {
    const result = await mintAccessToken(this.refreshToken, false, this.protoPost);
    this.accessToken = result.accessToken;
    if (result.refreshToken && result.refreshToken !== this.refreshToken) {
      this.refreshToken = result.refreshToken;
      this.emit("refreshToken", result.refreshToken);
    }
    await this.applyLoginCookie();
    this.emit(
      "debug",
      `minted access token, expires in ${Math.round(secondsUntilExpiry(result.accessToken))}s`,
    );
    return result.accessToken;
  }

  private readonly protoPost: ProtoPost = async (url, base64Body) => {
    const res = await this.http.post<Buffer | Uint8Array>(url, {
      form: { input_protobuf_encoded: base64Body },
      responseType: "buffer",
    });
    return {
      status: res.statusCode,
      eresult: headerValue(res.headers["x-eresult"]) ?? null,
      errorMessage: headerValue(res.headers["x-error_message"]) ?? null,
      body: res.body,
    };
  };

  private async applyLoginCookie(): Promise<void> {
    const value = encodeURIComponent(`${this.steamID.getSteamID64()}||${this.accessToken}`);
    await this.http.setCookie(`steamLoginSecure=${value}`);
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
