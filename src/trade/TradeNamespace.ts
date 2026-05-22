import SteamID from "steamid";
import type { ConfirmationManager } from "../community/confirmations.js";
import { DEFAULT_CONTEXTID, LANG, URLS } from "../core/constants.js";
import { EOfferFilter } from "../core/enums.js";
import { SteamError } from "../core/errors.js";
import { type Page, paginate } from "../core/paginate.js";
import { RETRY_AFTER } from "../core/rateLimits.js";
import { resolveTarget } from "../core/target.js";
import type { OfferTarget, RawCEconTradeOffer, RawGetTradeOffersResponse } from "../core/types.js";
import { httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";
import type { WebApiClient } from "../http/webApi.js";
import {
  type EconItem,
  parsePartnerInventory,
  type RawPartnerInventoryResponse,
} from "../models/EconItem.js";
import type { SessionManager } from "../session/SessionManager.js";
import { TradeOffer, type TradeOfferDeps } from "./TradeOffer.js";

export class TradeNamespace {
  constructor(
    private readonly api: WebApiClient,
    private readonly http: HttpClient,
    private readonly session: SessionManager,
    private readonly confirmations: ConfirmationManager,
  ) {}

  private offerDeps(): TradeOfferDeps {
    return {
      http: this.http,
      session: this.session,
      confirmations: this.confirmations,
      trade: this,
    };
  }

  // Local only — no network until send().
  createOffer(target: OfferTarget): TradeOffer {
    const { steamId, token } = resolveTarget(target);
    return new TradeOffer(this.offerDeps(), {
      partner: new SteamID(steamId),
      ...(token ? { token } : {}),
    });
  }

  async getTradeOffer(id: string): Promise<TradeOffer> {
    const body = await this.api.call<{ response?: { offer?: RawCEconTradeOffer } }>({
      httpMethod: "GET",
      iface: "IEconService",
      method: "GetTradeOffer",
      retryAfterMs: RETRY_AFTER.GetTradeOffer,
      input: { tradeofferid: id, ...LANG },
    });
    const raw = body.response?.offer;
    if (!raw) throw new SteamError(`Trade offer ${id} not found`);
    return TradeOffer.fromData(this.offerDeps(), raw);
  }

  async getTradeOffers(
    filter: EOfferFilter = EOfferFilter.ActiveOnly,
  ): Promise<RawGetTradeOffersResponse> {
    const body = await this.api.call<{ response?: RawGetTradeOffersResponse }>({
      httpMethod: "GET",
      iface: "IEconService",
      method: "GetTradeOffers",
      retryAfterMs: RETRY_AFTER.GetTradeOffers,
      input: {
        get_sent_offers: 1,
        get_received_offers: 1,
        get_descriptions: 1,
        active_only: filter === EOfferFilter.ActiveOnly ? 1 : 0,
        historical_only: filter === EOfferFilter.HistoricalOnly ? 1 : 0,
        ...LANG,
      },
    });
    return body.response ?? {};
  }

  async getInventory(
    target: OfferTarget,
    appid: number,
    contextid: string = DEFAULT_CONTEXTID,
    tradableOnly = false,
  ): Promise<EconItem[]> {
    await this.session.getAccessToken();
    const { steamId, token } = resolveTarget(target);
    const sessionid = await this.http.getSessionId();
    const accountId = new SteamID(steamId).accountid;
    const referer = `${URLS.community}/tradeoffer/new/?partner=${accountId}${token ? `&token=${token}` : ""}`;

    return paginate<EconItem, number>(async (start): Promise<Page<EconItem, number>> => {
      const res = await this.http.get<RawPartnerInventoryResponse>(
        `${URLS.community}/tradeoffer/new/partnerinventory/`,
        {
          responseType: "json",
          searchParams: {
            sessionid,
            partner: steamId,
            appid,
            contextid,
            ...(token ? { token } : {}),
            ...(start !== undefined ? { start } : {}),
            l: LANG.l,
          },
          headers: { Referer: referer },
        },
      );

      if (res.statusCode !== 200) throw httpError(res, RETRY_AFTER.partnerInventory);
      const body = res.body;
      if (!body?.success) throw new SteamError(body?.error ?? "Failed to load partner inventory");

      // Continue only when more_start actually advances, else a stuck cursor loops forever.
      const next =
        body.more && typeof body.more_start === "number" && body.more_start > (start ?? 0)
          ? body.more_start
          : undefined;
      return { items: parsePartnerInventory(body, contextid, tradableOnly), next };
    });
  }
}
