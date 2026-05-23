import { EventEmitter } from "node:events";
import type SteamID from "steamid";
import { CommunityNamespace } from "./community/CommunityNamespace.js";
import { ConfirmationManager } from "./community/confirmations.js";
import {
  type MobilePlatform,
  type MobileProfile,
  resolveMobileProfile,
} from "./core/mobileProfile.js";
import { HttpClient } from "./http/HttpClient.js";
import { WebApiClient } from "./http/webApi.js";
import { SessionManager } from "./session/SessionManager.js";
import type { PollOptions, TradeEvents } from "./trade/pollTypes.js";
import { TradeNamespace } from "./trade/TradeNamespace.js";

// Root surface: session lifecycle events + all trade events re-emitted (so consumers can listen on
// `bot` or `bot.trade`). `debug` comes from TradeEvents.
export interface SteamMobileEvents extends TradeEvents {
  refreshToken: [token: string];
  sessionExpired: [error: Error];
}

export interface SteamMobileOptions {
  refreshToken: string;
  identitySecret?: string;
  proxy?: string;
  // Wire impersonation: a string picks a preset ("ios" default, "android"); an object overrides individual fields.
  mobileProfile?: MobilePlatform | Partial<MobileProfile>;
  // Start polling after login. `true` uses defaults; pass PollOptions to tune cadence or resume from saved pollData.
  polling?: boolean | PollOptions;
}

export class SteamMobile extends EventEmitter<SteamMobileEvents> {
  readonly http: HttpClient;
  readonly session: SessionManager;
  readonly api: WebApiClient;
  readonly confirmations: ConfirmationManager;
  readonly trade: TradeNamespace;
  readonly community: CommunityNamespace;
  readonly identitySecret: string | undefined;
  private readonly polling: boolean | PollOptions | undefined;

  constructor(options: SteamMobileOptions) {
    super();
    const profile = resolveMobileProfile(options.mobileProfile);
    this.http = new HttpClient({
      ...(options.proxy ? { proxy: options.proxy } : {}),
      profile,
    });
    this.session = new SessionManager(this.http, options.refreshToken);
    this.identitySecret = options.identitySecret;
    this.polling = options.polling;
    this.api = new WebApiClient(this.http, () => this.session.getAccessToken());
    this.confirmations = new ConfirmationManager(
      this.http,
      this.session.steamID,
      options.identitySecret,
      profile,
    );
    this.trade = new TradeNamespace(this.api, this.http, this.session, this.confirmations);
    this.community = new CommunityNamespace(this.http, this.session, this.confirmations);

    this.session.on("refreshToken", (token) => this.emit("refreshToken", token));
    this.session.on("sessionExpired", (error) => this.emit("sessionExpired", error));
    this.session.on("debug", (message) => this.emit("debug", message));
    this.trade.on("debug", (message) => this.emit("debug", message));
    this.trade.on("newOffer", (o) => this.emit("newOffer", o));
    this.trade.on("sentOfferChanged", (o, s) => this.emit("sentOfferChanged", o, s));
    this.trade.on("receivedOfferChanged", (o, s) => this.emit("receivedOfferChanged", o, s));
    this.trade.on("unknownOfferSent", (o) => this.emit("unknownOfferSent", o));
    this.trade.on("pollData", (d) => this.emit("pollData", d));
    this.trade.on("pollSuccess", () => this.emit("pollSuccess"));
    this.trade.on("pollFailure", (e) => this.emit("pollFailure", e));
  }

  async login(): Promise<this> {
    await this.session.getAccessToken();
    if (this.polling) {
      this.trade.startPolling(this.polling === true ? {} : this.polling);
    }
    return this;
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
    this.trade.stopPolling();
    this.trade.removeAllListeners();
    this.removeAllListeners();
  }
}
