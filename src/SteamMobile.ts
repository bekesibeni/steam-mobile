import { EventEmitter } from "node:events";
import type SteamID from "steamid";
import { HttpClient } from "./http/HttpClient.js";
import { WebApiClient } from "./http/webApi.js";
import { SessionManager } from "./session/SessionManager.js";
import { TradeNamespace } from "./trade/TradeNamespace.js";

export interface SteamMobileEvents {
  refreshToken: [token: string];
  sessionExpired: [error: Error];
  debug: [message: string];
}

export interface SteamMobileOptions {
  identitySecret?: string;
  proxy?: string;
  userAgent?: string;
}

export class SteamMobile extends EventEmitter<SteamMobileEvents> {
  readonly http: HttpClient;
  readonly session: SessionManager;
  readonly api: WebApiClient;
  readonly trade: TradeNamespace;
  readonly identitySecret: string | undefined;

  private constructor(
    http: HttpClient,
    session: SessionManager,
    identitySecret: string | undefined,
  ) {
    super();
    this.http = http;
    this.session = session;
    this.identitySecret = identitySecret;
    this.api = new WebApiClient(http, () => session.getAccessToken());
    this.trade = new TradeNamespace(this.api);

    session.on("refreshToken", (token) => this.emit("refreshToken", token));
    session.on("sessionExpired", (error) => this.emit("sessionExpired", error));
    session.on("debug", (message) => this.emit("debug", message));
  }

  static async fromRefreshToken(
    refreshToken: string,
    options: SteamMobileOptions = {},
  ): Promise<SteamMobile> {
    const http = new HttpClient({
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    });
    const session = await SessionManager.fromRefreshToken(http, refreshToken);
    return new SteamMobile(http, session, options.identitySecret);
  }

  get steamID(): SteamID {
    return this.session.steamID;
  }

  get accessToken(): string | undefined {
    return this.session.accessToken;
  }

  get refreshToken(): string {
    return this.session.refreshToken;
  }

  async shutdown(): Promise<void> {
    this.removeAllListeners();
  }
}
